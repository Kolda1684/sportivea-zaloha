import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendRecord, journalPath, loadJournal, type JournalRecord } from '../../../src/core/download/journal'

let base: string
let destRoot: string

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-test-'))
  destRoot = path.join(base, 'Zaloha')
  await fs.mkdir(destRoot)
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

const rec = (fileId: string, over: Partial<JournalRecord> = {}): JournalRecord => ({
  fileId,
  localRelPath: `Zaloha/${fileId}.mp4`,
  size: 100,
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  modifiedTime: '2026-01-01T10:00:00.000Z',
  kind: 'file',
  localMtimeMs: 1_700_000_000_000,
  at: '2026-10-26T12:00:00.000Z',
  ...over,
})

describe('journalPath', () => {
  it('lives in .stahovani/journal.jsonl inside destRoot', () => {
    expect(journalPath('/x/Zaloha')).toBe('/x/Zaloha/.stahovani/journal.jsonl')
  })
})

describe('appendRecord + loadJournal', () => {
  it('round-trips records, creating .stahovani on the first append', async () => {
    const a = rec('a')
    const b = rec('b', { kind: 'export', md5: null, size: 12 })
    await appendRecord(destRoot, a)
    await appendRecord(destRoot, b)
    const map = await loadJournal(destRoot)
    expect(map.size).toBe(2)
    expect(map.get('a')).toEqual(a)
    expect(map.get('b')).toEqual(b)
    const text = await fs.readFile(journalPath(destRoot), 'utf8')
    expect(text.split('\n')).toHaveLength(3) // two lines + trailing newline
    expect(text.endsWith('\n')).toBe(true)
  })

  it('returns an empty map when there is no journal', async () => {
    expect((await loadJournal(destRoot)).size).toBe(0)
    await fs.mkdir(path.join(destRoot, '.stahovani'))
    expect((await loadJournal(destRoot)).size).toBe(0)
  })

  it('skips a damaged middle line and invalid records', async () => {
    await appendRecord(destRoot, rec('a'))
    await fs.appendFile(journalPath(destRoot), '{"fileId": "broken", "size"\n')
    await fs.appendFile(journalPath(destRoot), JSON.stringify({ ...rec('bad'), size: 'big' }) + '\n')
    await fs.appendFile(journalPath(destRoot), JSON.stringify({ fileId: 'partial-only' }) + '\n')
    await fs.appendFile(journalPath(destRoot), JSON.stringify(rec('x', { kind: 'skip' as never })) + '\n')
    await appendRecord(destRoot, rec('c'))
    const map = await loadJournal(destRoot)
    expect([...map.keys()].sort()).toEqual(['a', 'c'])
  })

  it('lets the last record per fileId win', async () => {
    await appendRecord(destRoot, rec('a', { size: 1 }))
    await appendRecord(destRoot, rec('b'))
    await appendRecord(destRoot, rec('a', { size: 2, at: '2026-10-27T12:00:00.000Z' }))
    const map = await loadJournal(destRoot)
    expect(map.size).toBe(2)
    expect(map.get('a')?.size).toBe(2)
  })

  it('starts a new line after a crash left a line without a trailing newline', async () => {
    await appendRecord(destRoot, rec('a'))
    await fs.appendFile(journalPath(destRoot), '{"fileId":"torn","localRel')
    await appendRecord(destRoot, rec('b'))
    const text = await fs.readFile(journalPath(destRoot), 'utf8')
    expect(text).toContain('{"fileId":"torn","localRel\n{"fileId":"b"')
    const map = await loadJournal(destRoot)
    expect([...map.keys()].sort()).toEqual(['a', 'b'])
  })

  it('does not add a blank line when the file ends cleanly', async () => {
    await appendRecord(destRoot, rec('a'))
    await appendRecord(destRoot, rec('b'))
    const text = await fs.readFile(journalPath(destRoot), 'utf8')
    expect(text).not.toContain('\n\n')
  })

  it('never creates destRoot itself', async () => {
    const missing = path.join(base, 'Neexistuje')
    await expect(appendRecord(missing, rec('a'))).rejects.toThrow()
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a record that does not match the schema and writes nothing', async () => {
    await expect(appendRecord(destRoot, { ...rec('a'), size: Number.NaN })).rejects.toThrow()
    await expect(fs.lstat(journalPath(destRoot))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('localRelPath validation', () => {
  it.each([
    '/etc/passwd',
    '../escape.mp4',
    'Zaloha/../../escape.mp4',
    'Zaloha/./a.mp4',
    'Zaloha//a.mp4',
    'Zaloha/a.mp4/',
    '.',
    '..',
  ])('skips a record with localRelPath %j', async (bad) => {
    await appendRecord(destRoot, rec('good'))
    await fs.appendFile(journalPath(destRoot), JSON.stringify({ ...rec('bad'), localRelPath: bad }) + '\n')
    const map = await loadJournal(destRoot)
    expect([...map.keys()]).toEqual(['good'])
    await expect(appendRecord(destRoot, rec('bad', { localRelPath: bad }))).rejects.toThrow()
  })

  it('accepts dots inside names', async () => {
    await appendRecord(destRoot, rec('a', { localRelPath: 'Zaloha/.hidden/a..b.mp4' }))
    expect((await loadJournal(destRoot)).size).toBe(1)
  })
})

describe('journal that is not a regular file', () => {
  it('refuses a symlinked journal and does not touch its target', async () => {
    const target = path.join(base, 'target.txt')
    await fs.writeFile(target, 'precious\n')
    await fs.mkdir(path.join(destRoot, '.stahovani'))
    await fs.symlink(target, journalPath(destRoot))
    await expect(loadJournal(destRoot)).rejects.toThrow(/Žurnál/)
    await expect(appendRecord(destRoot, rec('a'))).rejects.toThrow()
    expect(await fs.readFile(target, 'utf8')).toBe('precious\n')
  })

  it('refuses a journal that is a directory', async () => {
    await fs.mkdir(journalPath(destRoot), { recursive: true })
    await expect(loadJournal(destRoot)).rejects.toThrow(/Žurnál/)
    await expect(appendRecord(destRoot, rec('a'))).rejects.toThrow()
  })

  it('refuses a .stahovani that is a symlink or a file', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    await fs.mkdir(elsewhere)
    await fs.symlink(elsewhere, path.join(destRoot, '.stahovani'))
    await expect(loadJournal(destRoot)).rejects.toThrow(/Žurnál/)
    await expect(appendRecord(destRoot, rec('a'))).rejects.toThrow()
    expect(await fs.readdir(elsewhere)).toEqual([])

    await fs.rm(path.join(destRoot, '.stahovani'))
    await fs.writeFile(path.join(destRoot, '.stahovani'), 'x')
    await expect(loadJournal(destRoot)).rejects.toThrow(/Žurnál/)
    await expect(appendRecord(destRoot, rec('a'))).rejects.toThrow()
  })
})
