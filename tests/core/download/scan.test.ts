import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DriveClient, DriveError } from '../../../src/core/download/drive'
import type { TokenProvider } from '../../../src/core/download/drive'
import { scanFolder } from '../../../src/core/download/scan'
import type { DriveItem, PlanEntry } from '../../../src/core/download/types'
import { FOLDER_MIME, FakeDrive } from '../../helpers/fake-drive'

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const FORM_MIME = 'application/vnd.google-apps.form'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

let drive: FakeDrive
let client: DriveClient

beforeEach(async () => {
  drive = await FakeDrive.start()
  const tokens: TokenProvider = {
    getAccessToken: () => Promise.resolve('test-token'),
    refresh: () => Promise.resolve('test-token'),
  }
  client = new DriveClient({ tokens, baseUrl: drive.baseUrl, sleep: () => Promise.resolve(), maxRetries: 0 })
})

afterEach(async () => {
  await drive.close()
})

const entry = (entries: PlanEntry[], id: string): PlanEntry => {
  const found = entries.find((e) => e.fileId === id)
  if (!found) throw new Error(`no plan entry for ${id}`)
  return found
}

const item = (over: Partial<DriveItem> & { id: string; name: string }): DriveItem => ({
  mimeType: 'application/octet-stream',
  size: 1,
  md5: 'abc',
  createdTime: '2026-01-01T10:00:00.000Z',
  modifiedTime: '2026-01-02T10:00:00.000Z',
  canDownload: true,
  ...over,
})

describe('scanFolder', () => {
  it('walks a three-level tree breadth-first with paths relative to the chosen directory', async () => {
    const root = drive.addFolder('Zápas')
    const ids = drive.addTree(root, {
      'b.mp4': 'bbbb',
      'a.mp4': 'aa',
      Druhý: { 'c.mp4': 'ccc', Třetí: { 'd.mp4': 'dddddd' } },
      První: { 'e.mp4': 'e' },
    })
    const plan = await scanFolder(client, root)

    expect(plan.rootName).toBe('Zápas')
    expect(plan.folders).toEqual(['Zápas', 'Zápas/Druhý', 'Zápas/První', 'Zápas/Druhý/Třetí'])
    // breadth-first by folder, then by local name inside a folder
    expect(plan.entries.map((e) => e.localRelPath)).toEqual([
      'Zápas/a.mp4',
      'Zápas/b.mp4',
      'Zápas/Druhý/c.mp4',
      'Zápas/První/e.mp4',
      'Zápas/Druhý/Třetí/d.mp4',
    ])
    const d = entry(plan.entries, ids.get('Druhý/Třetí/d.mp4') ?? '')
    expect(d).toMatchObject({
      drivePath: 'Zápas/Druhý/Třetí/d.mp4',
      kind: 'file',
      size: 6,
      exportMime: null,
      skipReason: null,
    })
    expect(d.md5).toMatch(/^[0-9a-f]{32}$/)
    expect(plan.fileCount).toBe(5)
    expect(plan.totalBytes).toBe(4 + 2 + 3 + 6 + 1)
  })

  it('gives names that differ only in case distinct local names', async () => {
    const root = drive.addFolder('Root')
    const upper = drive.addFile(root, 'A.mp4', 'x', { createdTime: '2026-01-01T10:00:00.000Z' })
    const lower = drive.addFile(root, 'a.mp4', 'y', { createdTime: '2026-01-01T11:00:00.000Z' })
    const plan = await scanFolder(client, root)

    expect(entry(plan.entries, upper).localRelPath).toBe('Root/A.mp4')
    expect(entry(plan.entries, lower).localRelPath).toBe('Root/a (2).mp4')
    expect(entry(plan.entries, lower).drivePath).toBe('Root/a.mp4')
  })

  it('puts a subfolder and a file with the same name into one namespace', async () => {
    const root = drive.addFolder('Root')
    const sub = drive.addFolder('Klip', root, { createdTime: '2026-01-01T09:00:00.000Z' })
    const file = drive.addFile(root, 'Klip', 'x', { createdTime: '2026-01-01T10:00:00.000Z' })
    const inner = drive.addFile(sub, 'in.txt', 'z')
    const plan = await scanFolder(client, root)

    expect(plan.folders).toEqual(['Root', 'Root/Klip'])
    expect(entry(plan.entries, file).localRelPath).toBe('Root/Klip (2)')
    expect(entry(plan.entries, inner).localRelPath).toBe('Root/Klip/in.txt')
  })

  it('sanitizes the root name and every folder name', async () => {
    const root = drive.addFolder('Zápas: 1/2')
    const sub = drive.addFolder('a*b', root)
    const file = drive.addFile(sub, 'c.txt', 'x')
    const plan = await scanFolder(client, root)

    expect(plan.rootName).toBe('Zápas- 1-2')
    expect(plan.folders).toEqual(['Zápas- 1-2', 'Zápas- 1-2/a-b'])
    expect(entry(plan.entries, file)).toMatchObject({
      localRelPath: 'Zápas- 1-2/a-b/c.txt',
      drivePath: 'Zápas: 1/2/a*b/c.txt',
    })
  })

  it('plans a Google Doc as an export with the extension appended', async () => {
    const root = drive.addFolder('Root')
    const doc = drive.addGoogleDoc(root, 'Smlouva', { [DOCX_MIME]: 'docx bytes' })
    const plan = await scanFolder(client, root)

    expect(entry(plan.entries, doc)).toMatchObject({
      kind: 'export',
      localRelPath: 'Root/Smlouva.docx',
      drivePath: 'Root/Smlouva',
      exportMime: DOCX_MIME,
      size: null,
      md5: null,
      skipReason: null,
    })
    expect(plan.fileCount).toBe(1)
    expect(plan.totalBytes).toBe(0)
  })

  it('resolves a collision between an export and a real .docx using the final name', async () => {
    const root = drive.addFolder('Root')
    const real = drive.addFile(root, 'Smlouva.docx', 'real', { createdTime: '2026-01-01T09:00:00.000Z' })
    const doc = drive.addGoogleDoc(root, 'Smlouva', { [DOCX_MIME]: 'x' }, { createdTime: '2026-01-01T10:00:00.000Z' })
    const plan = await scanFolder(client, root)

    expect(entry(plan.entries, real).localRelPath).toBe('Root/Smlouva.docx')
    expect(entry(plan.entries, doc).localRelPath).toBe('Root/Smlouva (2).docx')
  })

  it('does not append the export extension twice, ignoring case', async () => {
    const root = drive.addFolder('Root')
    const lower = drive.addGoogleDoc(root, 'x.docx', { [DOCX_MIME]: 'x' })
    const upper = drive.addGoogleDoc(root, 'Y.DOCX', { [DOCX_MIME]: 'x' })
    const plain = drive.addGoogleDoc(root, 'z', { [DOCX_MIME]: 'x' })
    const plan = await scanFolder(client, root)

    expect(entry(plan.entries, lower).localRelPath).toBe('Root/x.docx')
    expect(entry(plan.entries, upper).localRelPath).toBe('Root/Y.DOCX')
    expect(entry(plan.entries, plain).localRelPath).toBe('Root/z.docx')
  })

  it('still collides a Doc named x.docx with a real x.docx file', async () => {
    const root = drive.addFolder('Root')
    const real = drive.addFile(root, 'x.docx', 'real', { createdTime: '2026-01-01T09:00:00.000Z' })
    const doc = drive.addGoogleDoc(root, 'x.docx', { [DOCX_MIME]: 'x' }, { createdTime: '2026-01-01T10:00:00.000Z' })
    const plan = await scanFolder(client, root)

    expect(entry(plan.entries, real).localRelPath).toBe('Root/x.docx')
    expect(entry(plan.entries, doc).localRelPath).toBe('Root/x (2).docx')
  })

  it('gives a folder and a file that differ only in case distinct names', async () => {
    const root = drive.addFolder('Root')
    const sub = drive.addFolder('Klip', root, { createdTime: '2026-01-01T09:00:00.000Z' })
    const file = drive.addFile(root, 'klip', 'x', { createdTime: '2026-01-01T10:00:00.000Z' })
    const plan = await scanFolder(client, root)

    expect(plan.folders).toEqual(['Root', 'Root/Klip'])
    expect(entry(plan.entries, file).localRelPath).toBe('Root/klip (2)')
    expect(sub).not.toBe(file)
  })

  it('skips a Google Form with a reason and keeps its name in the namespace', async () => {
    const root = drive.addFolder('Root')
    const form = drive.addGoogleDoc(root, 'Dotazník', {}, { mimeType: FORM_MIME, createdTime: '2026-01-01T09:00:00.000Z' })
    const same = drive.addFile(root, 'Dotazník', 'x', { createdTime: '2026-01-01T10:00:00.000Z' })
    const plan = await scanFolder(client, root)

    const skipped = entry(plan.entries, form)
    expect(skipped.kind).toBe('skip')
    expect(skipped.skipReason).toBe('tento typ Google souboru nejde stáhnout')
    expect(skipped.localRelPath).toBe('Root/Dotazník')
    expect(entry(plan.entries, same).localRelPath).toBe('Root/Dotazník (2)')
    expect(plan.fileCount).toBe(1)
  })

  it('skips a shortcut and never lists its target', async () => {
    const root = drive.addFolder('Root')
    const elsewhere = drive.addFolder('Jinde')
    drive.addFile(elsewhere, 'tajne.txt', 'x')
    const shortcut = drive.addFile(root, 'Odkaz na Jinde', '', { mimeType: SHORTCUT_MIME })
    drive.clearLog()
    const plan = await scanFolder(client, root)

    expect(entry(plan.entries, shortcut)).toMatchObject({ kind: 'skip', skipReason: 'zástupce (nestahuje se)' })
    expect(plan.folders).toEqual(['Root'])
    const listCalls = drive.requests.filter((r) => r.path === `/drive/v3/files` && r.query['q']?.includes(elsewhere))
    expect(listCalls).toEqual([])
    expect(drive.requests.filter((r) => r.path.includes(elsewhere))).toEqual([])
  })

  it('plans a file whose owner disabled downloading as blocked (never skipped), also an exportable one', async () => {
    const root = drive.addFolder('Root')
    const locked = drive.addFile(root, 'locked.mp4', 'xxxx', { canDownload: false })
    const lockedDoc = drive.addGoogleDoc(root, 'Doc', { [DOCX_MIME]: 'x' }, { canDownload: false })
    const ok = drive.addFile(root, 'ok.mp4', 'yy')
    const plan = await scanFolder(client, root)

    expect(entry(plan.entries, locked)).toMatchObject({ kind: 'file', blocked: true, skipReason: null, size: 4 })
    expect(entry(plan.entries, lockedDoc)).toMatchObject({
      kind: 'export',
      blocked: true,
      skipReason: null,
      exportMime: DOCX_MIME,
      localRelPath: 'Root/Doc.docx',
    })
    expect(entry(plan.entries, ok)).toMatchObject({ kind: 'file', blocked: false })
    // Blocked items are planned files: they count, so a run without them can never be "complete".
    expect(plan.fileCount).toBe(3)
    expect(plan.totalBytes).toBe(6)
  })

  it('counts only files and exports, and sums only files with a known size', async () => {
    const root = drive.addFolder('Root')
    drive.addFile(root, 'a.bin', '12345')
    drive.addFile(root, 'b.bin', '123')
    drive.addGoogleDoc(root, 'Doc', { [DOCX_MIME]: 'x' })
    drive.addGoogleDoc(root, 'Form', {}, { mimeType: FORM_MIME })
    drive.addFile(root, 'sc', '', { mimeType: SHORTCUT_MIME })
    drive.addFile(root, 'locked.bin', '1234567', { canDownload: false })
    const plan = await scanFolder(client, root)

    expect(plan.entries).toHaveLength(6)
    expect(plan.fileCount).toBe(4)
    expect(plan.totalBytes).toBe(15)
  })

  it('reports growing counts through onProgress', async () => {
    const root = drive.addFolder('Root')
    drive.addFile(root, 'a.bin', '12')
    const s1 = drive.addFolder('S1', root)
    drive.addFile(s1, 'b.bin', '123')
    const s2 = drive.addFolder('S2', s1)
    drive.addFile(s2, 'c.bin', '12345')
    const seen: { files: number; bytes: number }[] = []
    await scanFolder(client, root, (found) => seen.push({ ...found }))

    expect(seen).toEqual([
      { files: 1, bytes: 2 },
      { files: 2, bytes: 5 },
      { files: 3, bytes: 10 },
    ])
  })

  it('handles an empty folder and a folder of only subfolders', async () => {
    const root = drive.addFolder('Root')
    drive.addFolder('Prázdná', root)
    const plan = await scanFolder(client, root)

    expect(plan.entries).toEqual([])
    expect(plan.folders).toEqual(['Root', 'Root/Prázdná'])
    expect(plan.fileCount).toBe(0)
    expect(plan.totalBytes).toBe(0)
  })

  it('scans a folder with more files than one page', async () => {
    const root = drive.addFolder('Root')
    drive.maxPageSize = 7
    drive.addFiles(root, 20)
    const plan = await scanFolder(client, root)
    expect(plan.fileCount).toBe(20)
  })

  describe('errors', () => {
    it('re-labels a missing root folder in Czech', async () => {
      const error = await scanFolder(client, 'neexistuje').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DriveError)
      expect((error as DriveError).kind).toBe('not_found')
      expect((error as DriveError).message).toBe('Složku se nepodařilo najít. Zkontroluj odkaz a že k ní máš přístup.')
    })

    it('rejects an id that is not a folder', async () => {
      const file = drive.addFile(null, 'a.mp4', 'x')
      await expect(scanFolder(client, file)).rejects.toThrow('Odkaz nevede na složku.')
    })

    it('rejects a shortcut as the root', async () => {
      const sc = drive.addFile(null, 'sc', '', { mimeType: SHORTCUT_MIME })
      await expect(scanFolder(client, sc)).rejects.toThrow('Odkaz nevede na složku.')
    })

    it('lets a not_found deeper in the tree propagate unchanged', async () => {
      const root = drive.addFolder('Root')
      const sub = drive.addFolder('Sub', root)
      drive.scriptFailures((r) => r.path === '/drive/v3/files' && (r.query['q'] ?? '').includes(sub), [
        { status: 404, reason: 'notFound', message: 'deep' },
      ])
      const error = await scanFolder(client, root).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DriveError)
      expect((error as DriveError).kind).toBe('not_found')
      expect((error as DriveError).message).not.toContain('Složku se nepodařilo najít')
    })

    it('stops with the abort reason when the signal is aborted', async () => {
      const root = drive.addFolder('Root')
      drive.addFolder('Sub', root)
      const controller = new AbortController()
      controller.abort(new Error('stop'))
      await expect(scanFolder(client, root, undefined, controller.signal)).rejects.toThrow('stop')
    })
  })

  describe('with a stubbed client', () => {
    it('passes the signal to every client call', async () => {
      const signals: (AbortSignal | undefined)[] = []
      const folder = (id: string): DriveItem => item({ id, name: id, mimeType: FOLDER_MIME, size: null, md5: null })
      const stub = {
        getItem: (id: string, signal?: AbortSignal) => {
          signals.push(signal)
          return Promise.resolve(folder(id))
        },
        listChildren: (id: string, signal?: AbortSignal) => {
          signals.push(signal)
          return Promise.resolve(id === 'root' ? [folder('sub'), item({ id: 'f', name: 'f.txt' })] : [])
        },
      }
      const controller = new AbortController()
      await scanFolder(stub, 'root', undefined, controller.signal)
      expect(signals).toHaveLength(3)
      expect(signals.every((s) => s === controller.signal)).toBe(true)
    })

    it('lists a repeated folder id once and records the repeat as a skipped entry', async () => {
      const folder = (id: string): DriveItem => item({ id, name: id, mimeType: FOLDER_MIME, size: null, md5: null })
      const listed: string[] = []
      const stub = {
        getItem: (id: string) => Promise.resolve(folder(id)),
        listChildren: (id: string) => {
          listed.push(id)
          // root contains A twice and itself; A contains root and itself: a cycle
          if (id === 'root') return Promise.resolve([folder('A'), folder('A'), folder('root')])
          return Promise.resolve([folder('root'), folder('A'), item({ id: 'f', name: 'f.txt' })])
        },
      }
      const plan = await scanFolder(stub, 'root')
      expect(listed).toEqual(['root', 'A'])
      expect(plan.folders).toEqual(['root', 'root/A'])
      expect(plan.fileCount).toBe(1)
      const skips = plan.entries.filter((e) => e.kind === 'skip')
      expect(skips.map((e) => [e.localRelPath, e.skipReason])).toEqual([
        ['root/A (2)', 'složka se opakuje (nestahuje se)'],
        ['root/root', 'složka se opakuje (nestahuje se)'],
        ['root/A/A', 'složka se opakuje (nestahuje se)'],
        ['root/A/root', 'složka se opakuje (nestahuje se)'],
      ])
      expect(plan.entries.map((e) => e.localRelPath)).toEqual([
        'root/A (2)',
        'root/root',
        'root/A/A',
        'root/A/f.txt',
        'root/A/root',
      ])
      expect(skips[0]).toMatchObject({ fileId: 'A', size: null, md5: null, exportMime: null, mimeType: FOLDER_MIME })
    })
  })
  it('marks later files with the same MD5 and size as duplicates and leaves them out of the totals', async () => {
    const root = drive.addFolder('Klient')
    drive.addTree(root, {
      'a.mp4': 'same bytes',
      'b.mp4': 'other',
      Kopie: { 'a kopie.mp4': 'same bytes', 'c.mp4': 'same bytes' },
    })
    const plan = await scanFolder(client, root)

    expect(plan.entries.map((e) => [e.localRelPath, e.duplicate])).toEqual([
      ['Klient/a.mp4', false],
      ['Klient/b.mp4', false],
      ['Klient/Kopie/a kopie.mp4', true],
      ['Klient/Kopie/c.mp4', true],
    ])
    expect(plan.fileCount).toBe(2)
    expect(plan.totalBytes).toBe('same bytes'.length + 'other'.length)
    expect(plan.duplicateCount).toBe(2)
    expect(plan.duplicateBytes).toBe(2 * 'same bytes'.length)
  })

  it('never marks Google exports or files without an MD5 as duplicates', async () => {
    const root = drive.addFolder('Klient')
    drive.addGoogleDoc(root, 'Smlouva', { [DOCX_MIME]: 'x' })
    drive.addGoogleDoc(root, 'Smlouva kopie', { [DOCX_MIME]: 'x' })
    const plan = await scanFolder(client, root)

    expect(plan.entries.every((e) => !e.duplicate)).toBe(true)
    expect(plan.duplicateCount).toBe(0)
    expect(plan.fileCount).toBe(2)
  })
})
