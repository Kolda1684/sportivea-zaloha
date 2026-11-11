import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDrive } from './fake-drive'

const get = (drive: FakeDrive, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${drive.baseUrl}${path}`, { headers: { authorization: 'Bearer test-token', ...headers } })

describe('FakeDrive (test helper)', () => {
  let drive: FakeDrive

  beforeEach(async () => {
    drive = await FakeDrive.start()
  })
  afterEach(async () => {
    await drive.close()
  })

  it('builds a tree and lists children', async () => {
    const root = drive.addFolder('Root')
    const ids = drive.addTree(root, { 'a.txt': 'A', sub: { 'b.txt': 'B' } })
    expect([...ids.keys()]).toEqual(['a.txt', 'sub', 'sub/b.txt'])
    const body = (await (await get(drive, `/files?q=${encodeURIComponent(`'${root}' in parents and trashed=false`)}`)).json()) as {
      files: { name: string }[]
    }
    expect(body.files.map((f) => f.name)).toEqual(['a.txt', 'sub'])
  })

  it('updateFile changes bytes, md5 and modifiedTime between runs', async () => {
    const id = drive.addFile(null, 'a.txt', 'one')
    const before = (await (await get(drive, `/files/${id}`)).json()) as { md5Checksum: string; size: string; modifiedTime: string }
    drive.updateFile(id, { bytes: 'three', modifiedTime: '2026-02-02T00:00:00.000Z' })
    const after = (await (await get(drive, `/files/${id}`)).json()) as { md5Checksum: string; size: string; modifiedTime: string }
    expect(after.size).toBe('5')
    expect(after.md5Checksum).not.toBe(before.md5Checksum)
    expect(after.modifiedTime).toBe('2026-02-02T00:00:00.000Z')
    drive.updateFile(id, { md5: 'f'.repeat(32) })
    expect(((await (await get(drive, `/files/${id}`)).json()) as { md5Checksum: string }).md5Checksum).toBe('f'.repeat(32))
  })

  it('controls tokens: accepted set and reject-all', async () => {
    const id = drive.addFile(null, 'a.txt', 'x')
    drive.acceptTokens('one', 'two')
    expect((await get(drive, `/files/${id}`)).status).toBe(401)
    const withToken = (t: string): Promise<Response> => fetch(`${drive.baseUrl}/files/${id}`, { headers: { authorization: `Bearer ${t}` } })
    expect((await withToken('two')).status).toBe(200)
    drive.rejectAllTokens()
    expect((await withToken('two')).status).toBe(401)
    drive.acceptTokens('two')
    expect((await withToken('two')).status).toBe(200)
  })

  it('logs method, path, query, headers and status', async () => {
    const id = drive.addFile(null, 'a.txt', 'x')
    await get(drive, `/files/${id}?alt=media`, { range: 'bytes=0-' })
    expect(drive.requests).toHaveLength(1)
    expect(drive.requests[0]).toMatchObject({
      method: 'GET',
      path: drive.filePath(id),
      query: { alt: 'media' },
      status: 206,
    })
    expect(drive.requests[0]?.headers.range).toBe('bytes=0-')
    drive.clearLog()
    expect(drive.requests).toHaveLength(0)
  })

  it('serves Range requests, and 416 past the end', async () => {
    const id = drive.addFile(null, 'a.txt', '0123456789')
    const part = await get(drive, `/files/${id}?alt=media`, { range: 'bytes=3-5' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 3-5/10')
    expect(await part.text()).toBe('345')
    expect((await get(drive, `/files/${id}?alt=media`, { range: 'bytes=10-' })).status).toBe(416)
  })

  it('counts concurrent downloads', async () => {
    const id = drive.addFile(null, 'a.txt', 'x'.repeat(100))
    drive.chunkDelayMs = 50
    await Promise.all([1, 2, 3].map(async () => (await get(drive, `/files/${id}?alt=media`)).text()))
    expect(drive.maxConcurrentDownloads).toBe(3)
    expect(drive.activeDownloads).toBe(0)
    drive.resetConcurrency()
    await (await get(drive, `/files/${id}?alt=media`)).text()
    expect(drive.maxConcurrentDownloads).toBe(1)
  })

  it('scripts failures per path, in order, then returns to normal', async () => {
    const a = drive.addFile(null, 'a.txt', 'x')
    const b = drive.addFile(null, 'b.txt', 'x')
    drive.scriptFailures(drive.filePath(a), [{ status: 503 }, { kind: 'pass' }, { status: 500 }])
    expect((await get(drive, `/files/${a}`)).status).toBe(503)
    expect((await get(drive, `/files/${b}`)).status).toBe(200)
    expect((await get(drive, `/files/${a}`)).status).toBe(200)
    expect((await get(drive, `/files/${a}`)).status).toBe(500)
    expect((await get(drive, `/files/${a}`)).status).toBe(200)
  })

  it('hides shared-drive items from requests without supportsAllDrives=true', async () => {
    const folder = drive.addFolder('Shared', null, { sharedDrive: true })
    const file = drive.addFile(folder, 'a.txt', 'x', { sharedDrive: true })
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`)
    expect((await get(drive, `/files/${folder}`)).status).toBe(404)
    expect((await get(drive, `/files/${file}?alt=media`)).status).toBe(404)
    expect((await get(drive, `/files/${folder}?supportsAllDrives=true`)).status).toBe(200)
    const names = async (query: string): Promise<number> =>
      ((await (await get(drive, `/files?q=${q}${query}`)).json()) as { files: unknown[] }).files.length
    expect(await names('')).toBe(0)
    expect(await names('&supportsAllDrives=true')).toBe(0)
    expect(await names('&includeItemsFromAllDrives=true')).toBe(0)
    expect(await names('&supportsAllDrives=true&includeItemsFromAllDrives=true')).toBe(1)
  })

  it('serves empty and short pages that still carry a nextPageToken (pageSizes)', async () => {
    const folder = drive.addFolder('F')
    drive.addFiles(folder, 4)
    drive.pageSizes = [0, 2]
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`)
    const tokens: (string | undefined)[] = []
    const counts: number[] = []
    let token: string | undefined
    do {
      const body = (await (await get(drive, `/files?q=${q}${token ? `&pageToken=${token}` : ''}`)).json()) as {
        files: unknown[]
        nextPageToken?: string
      }
      counts.push(body.files.length)
      token = body.nextPageToken
      tokens.push(token)
    } while (token !== undefined)
    expect(counts).toEqual([0, 2, 0, 2])
    expect(new Set(tokens).size).toBe(tokens.length)
  })
})
