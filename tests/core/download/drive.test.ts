import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DriveClient, DriveError, parseFolderLink } from '../../../src/core/download/drive'
import type { TokenProvider } from '../../../src/core/download/drive'
import { FakeDrive } from '../../helpers/fake-drive'

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz'

describe('parseFolderLink', () => {
  it.each([
    ['plain folder link', `https://drive.google.com/drive/folders/${ID}`],
    ['link with /u/<n>/ and query', `https://drive.google.com/drive/u/0/folders/${ID}?usp=sharing`],
    ['link with trailing slash', `https://drive.google.com/drive/folders/${ID}/`],
    ['open?id= link', `https://drive.google.com/open?id=${ID}`],
    ['bare id', ID],
  ])('accepts %s', (_name, input) => {
    expect(parseFolderLink(input)).toBe(ID)
  })

  it('ignores surrounding whitespace', () => {
    expect(parseFolderLink(`  ${ID}\n`)).toBe(ID)
  })

  it.each([
    ['other domain', `https://example.com/drive/folders/${ID}`],
    ['look-alike host', `https://drive.google.com.evil.example/drive/folders/${ID}`],
    ['file link', `https://drive.google.com/file/d/${ID}/view`],
    ['empty', ''],
    ['too short for an id', 'abc123'],
  ])('rejects %s', (_name, input) => {
    expect(parseFolderLink(input)).toBeNull()
  })
})

type Harness = {
  drive: FakeDrive
  client: DriveClient
  tokens: { current: string; refreshCalls: number; next: string }
  sleeps: number[]
  makeClient: (maxRetries?: number) => DriveClient
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer())
}

describe('DriveClient', () => {
  let h: Harness

  beforeEach(async () => {
    const drive = await FakeDrive.start()
    const state = { current: 'test-token', refreshCalls: 0, next: 'test-token' }
    const tokens: TokenProvider = {
      getAccessToken: () => Promise.resolve(state.current),
      refresh: () => {
        state.refreshCalls += 1
        state.current = state.next
        return Promise.resolve(state.current)
      },
    }
    const sleeps: number[] = []
    const makeClient = (maxRetries?: number): DriveClient =>
      new DriveClient({
        tokens,
        baseUrl: drive.baseUrl,
        sleep: (ms) => {
          sleeps.push(ms)
          return Promise.resolve()
        },
        ...(maxRetries === undefined ? {} : { maxRetries }),
      })
    h = { drive, client: makeClient(), tokens: state, sleeps, makeClient }
  })

  afterEach(async () => {
    await h.drive.close()
  })

  describe('getItem / listChildren', () => {
    it('maps a file resource to a DriveItem', async () => {
      const id = h.drive.addFile(null, 'Clip.MP4', 'hello', { mimeType: 'video/mp4' })
      const item = await h.client.getItem(id)
      expect(item).toEqual({
        id,
        name: 'Clip.MP4',
        mimeType: 'video/mp4',
        size: 5,
        md5: '5d41402abc4b2a76b9719d911017c592',
        createdTime: '2026-01-01T10:00:00.000Z',
        modifiedTime: '2026-01-02T10:00:00.000Z',
        canDownload: true,
      })
      const request = h.drive.requests[0]
      expect(request?.query['fields']).toBe('id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,capabilities/canDownload')
    })

    it('reports a missing size and md5 as null and canDownload=false as false', async () => {
      const doc = h.drive.addGoogleDoc(null, 'Doc', {}, { canDownload: false })
      const item = await h.client.getItem(doc)
      expect(item.size).toBeNull()
      expect(item.md5).toBeNull()
      expect(item.canDownload).toBe(false)
    })

    it('returns all 2 500 children across 3 pages', async () => {
      const folder = h.drive.addFolder('Big')
      const ids = h.drive.addFiles(folder, 2500)
      h.drive.addFiles(h.drive.addFolder('Other'), 3)
      const items = await h.client.listChildren(folder)
      expect(items.map((i) => i.id)).toEqual(ids)
      const lists = h.drive.requests.filter((r) => r.path.endsWith('/files'))
      expect(lists).toHaveLength(3)
      expect(lists[0]?.query).toMatchObject({
        q: `'${folder}' in parents and trashed=false`,
        includeItemsFromAllDrives: 'true',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,capabilities/canDownload)',
      })
      expect(lists[0]?.query['pageToken']).toBeUndefined()
      expect(lists[1]?.query['pageToken']).toBeDefined()
      expect(lists[2]?.query['pageToken']).toBeDefined()
    })

    it('returns an empty list for an empty folder', async () => {
      expect(await h.client.listChildren(h.drive.addFolder('Empty'))).toEqual([])
    })

    it('escapes quotes in the folder id inside the query', async () => {
      await h.client.listChildren("a'b\\c")
      expect(h.drive.requests[0]?.query['q']).toBe("'a\\'b\\\\c' in parents and trashed=false")
    })
  })

  describe('requests', () => {
    it('every request is a GET with supportsAllDrives=true and the token only in the header', async () => {
      const folder = h.drive.addFolder('F')
      const file = h.drive.addFile(folder, 'a.bin', 'abcdef')
      const doc = h.drive.addGoogleDoc(folder, 'Doc', { 'application/pdf': 'pdf' })
      await h.client.getItem(folder)
      await h.client.listChildren(folder)
      await readAll(await h.client.download(file, 0))
      await readAll(await h.client.download(file, 2))
      await readAll(await h.client.exportFile(doc, 'application/pdf'))
      expect(h.drive.requests).toHaveLength(5)
      for (const r of h.drive.requests) {
        expect(r.method).toBe('GET')
        expect(r.query['supportsAllDrives']).toBe('true')
        expect(r.headers.authorization).toBe('Bearer test-token')
        expect(r.rawUrl).not.toContain('test-token')
        expect(r.rawUrl).not.toMatch(/access_token|key=/)
      }
    })
  })

  describe('authentication', () => {
    it('refreshes once on 401', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.acceptTokens('fresh')
      h.tokens.current = 'stale'
      h.tokens.next = 'fresh'
      const item = await h.client.getItem(id)
      expect(item.id).toBe(id)
      expect(h.tokens.refreshCalls).toBe(1)
      expect(h.drive.requests.map((r) => r.status)).toEqual([401, 200])
      expect(h.sleeps).toEqual([])
    })

    it('fails with kind auth when the refreshed token is rejected too', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.acceptTokens('fresh')
      h.tokens.current = 'stale'
      h.tokens.next = 'also-stale'
      const error = await h.client.getItem(id).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DriveError)
      expect(error).toMatchObject({ kind: 'auth', status: 401 })
      expect(h.tokens.refreshCalls).toBe(1)
      expect(h.drive.requests).toHaveLength(2)
    })

    it('fails with kind auth when the token provider cannot refresh', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      const client = new DriveClient({
        tokens: {
          getAccessToken: () => Promise.resolve('stale'),
          refresh: () => Promise.reject(new Error('invalid_grant')),
        },
        baseUrl: h.drive.baseUrl,
      })
      await expect(client.getItem(id)).rejects.toMatchObject({ kind: 'auth' })
    })

    it('does not use up retries on a refresh', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.acceptTokens('fresh')
      h.tokens.current = 'stale'
      h.tokens.next = 'fresh'
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 503 }])
      const client = h.makeClient(1)
      await expect(client.getItem(id)).resolves.toMatchObject({ id })
      expect(h.sleeps).toEqual([1000])
    })
  })

  describe('retries', () => {
    it('retries 503, 503, 200 with backoff 1 s and 2 s', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 503 }, { status: 503 }])
      await expect(h.client.getItem(id)).resolves.toMatchObject({ id })
      expect(h.sleeps).toEqual([1000, 2000])
      expect(h.drive.requests.map((r) => r.status)).toEqual([503, 503, 200])
    })

    it('doubles the delay up to 32 s and then gives up with kind server', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), Array.from({ length: 20 }, () => ({ status: 500 })))
      const error = await h.makeClient(8).getItem(id).catch((e: unknown) => e)
      expect(error).toMatchObject({ kind: 'server', status: 500 })
      expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000])
      expect(h.drive.requests).toHaveLength(9)
    })

    it('defaults to 6 retries', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), Array.from({ length: 20 }, () => ({ status: 502 })))
      await expect(h.client.getItem(id)).rejects.toMatchObject({ kind: 'server' })
      expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000])
    })

    it('retries 429 and reports rate_limit when retries run out', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 429 }, { status: 429 }, { status: 429 }])
      const error = await h.makeClient(2).getItem(id).catch((e: unknown) => e)
      expect(error).toMatchObject({ kind: 'rate_limit', status: 429 })
      expect(h.drive.requests).toHaveLength(3)
    })

    it.each(['rateLimitExceeded', 'userRateLimitExceeded'])('retries 403 %s', async (reason) => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 403, reason }])
      await expect(h.client.getItem(id)).resolves.toMatchObject({ id })
      expect(h.sleeps).toEqual([1000])
    })

    it('retries a dropped connection and reports network when retries run out', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ kind: 'drop' }])
      await expect(h.client.getItem(id)).resolves.toMatchObject({ id })
      expect(h.sleeps).toEqual([1000])

      h.sleeps.length = 0
      h.drive.scriptFailures(h.drive.filePath(id), Array.from({ length: 10 }, () => ({ kind: 'drop' as const })))
      const error = await h.makeClient(2).getItem(id).catch((e: unknown) => e)
      expect(error).toMatchObject({ kind: 'network', status: null })
      expect(h.sleeps).toEqual([1000, 2000])
    })

    it('retries a rejected fetch', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      let calls = 0
      const client = new DriveClient({
        tokens: { getAccessToken: () => Promise.resolve('test-token'), refresh: () => Promise.resolve('test-token') },
        baseUrl: h.drive.baseUrl,
        sleep: () => Promise.resolve(),
        fetchFn: (input, init) => {
          calls += 1
          return calls === 1 ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init)
        },
      })
      await expect(client.getItem(id)).resolves.toMatchObject({ id })
      expect(calls).toBe(2)
    })

    it('retries a download whose connection drops before the headers', async () => {
      const file = h.drive.addFile(null, 'b.bin', 'abcdef')
      h.drive.scriptFailures(h.drive.filePath(file), [{ kind: 'drop' }])
      await expect(readAll(await h.client.download(file, 0))).resolves.toEqual(Buffer.from('abcdef'))
      expect(h.sleeps).toEqual([1000])
    })

    it('retries when a JSON body breaks off before it is complete', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      let calls = 0
      const client = new DriveClient({
        tokens: { getAccessToken: () => Promise.resolve('test-token'), refresh: () => Promise.resolve('test-token') },
        baseUrl: h.drive.baseUrl,
        sleep: () => Promise.resolve(),
        fetchFn: async (input, init) => {
          calls += 1
          const res = await fetch(input, init)
          if (calls > 1) return res
          await res.body?.cancel()
          return { ok: true, status: 200, text: () => Promise.reject(new TypeError('terminated')) } as unknown as Response
        },
      })
      await expect(client.getItem(id)).resolves.toMatchObject({ id })
      expect(calls).toBe(2)
    })

    it('does not retry when the signal is aborted', async () => {
      const file = h.drive.addFile(null, 'b.bin', 'abcdef')
      const controller = new AbortController()
      controller.abort()
      const error = await h.client.download(file, 0, controller.signal).catch((e: unknown) => e)
      expect(error).not.toBeInstanceOf(DriveError)
      expect(h.drive.requests).toHaveLength(0)
      expect(h.sleeps).toEqual([])
    })
  })

  describe('permanent errors', () => {
    it.each([
      ['cannotDownloadFile', 'vlastník zakázal stahování'],
      ['cannotDownloadAbusiveFile', 'Google soubor označil jako nebezpečný'],
      ['exportSizeLimitExceeded', 'soubor je příliš velký na export z Google Dokumentů'],
    ])('403 %s -> cannot_download without retry', async (reason, message) => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 403, reason }])
      const error = await h.client.download(id, 0).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DriveError)
      expect(error).toMatchObject({ kind: 'cannot_download', status: 403, message })
      expect(h.drive.requests).toHaveLength(1)
      expect(h.sleeps).toEqual([])
    })

    it('403 from the server for a file with canDownload=false is cannot_download', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x', { canDownload: false })
      await expect(h.client.download(id, 0)).rejects.toMatchObject({ kind: 'cannot_download' })
    })

    it('other 403 -> forbidden, 404 -> not_found, neither is retried', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 403, reason: 'insufficientFilePermissions' }])
      await expect(h.client.getItem(id)).rejects.toMatchObject({ kind: 'forbidden', status: 403 })
      await expect(h.client.getItem('does-not-exist')).rejects.toMatchObject({ kind: 'not_found', status: 404 })
      expect(h.drive.requests).toHaveLength(2)
      expect(h.sleeps).toEqual([])
    })

    it('falls back to the status code when the error body is missing or not Google JSON', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [
        { status: 403, body: '' },
        { status: 403, body: '<html>Forbidden</html>' },
        { status: 403, body: '{"error":"nope"}' },
        { status: 404, body: 'gone' },
      ])
      for (let i = 0; i < 3; i += 1) {
        await expect(h.client.getItem(id)).rejects.toMatchObject({ kind: 'forbidden' })
      }
      await expect(h.client.getItem(id)).rejects.toMatchObject({ kind: 'not_found' })
    })

    it('treats an unexpected 400 as a non-retried server error', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 400, reason: 'invalid', message: 'Bad' }])
      await expect(h.client.getItem(id)).rejects.toMatchObject({ kind: 'server', status: 400 })
      expect(h.sleeps).toEqual([])
    })

    it('rejects a response that is not a file resource with kind server', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 200, body: '{"id":5}' }])
      await expect(h.client.getItem(id)).rejects.toMatchObject({ kind: 'server' })
    })
  })

  describe('download / exportFile', () => {
    it('downloads the whole file without a Range header', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'abcdefghij')
      const bytes = await readAll(await h.client.download(id, 0))
      expect(bytes.toString()).toBe('abcdefghij')
      expect(h.drive.requests[0]?.query['alt']).toBe('media')
      expect(h.drive.requests[0]?.headers.range).toBeUndefined()
    })

    it('downloads from byte 5 with a Range header and gets bytes 5..end', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'abcdefghij')
      const bytes = await readAll(await h.client.download(id, 5))
      expect(bytes.toString()).toBe('fghij')
      expect(h.drive.requests[0]?.headers.range).toBe('bytes=5-')
      expect(h.drive.requests[0]?.status).toBe(206)
    })

    it('fails with kind server when the server answers 200 to a Range request', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'abcdefghij')
      h.drive.ignoreRange = true
      const error = await h.client.download(id, 5).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DriveError)
      expect(error).toMatchObject({ kind: 'server', status: 200 })
      expect(h.sleeps).toEqual([])
      expect(h.drive.requests).toHaveLength(1)
    })

    it('fails with kind server when the 206 starts at another offset', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'abcdefghij')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 206, body: 'abcdefghij', headers: { 'content-range': 'bytes 0-9/10' } }])
      await expect(h.client.download(id, 5)).rejects.toMatchObject({ kind: 'server', status: 206 })
    })

    it('fails with kind server when the offset is past the end (416)', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'abc')
      await expect(h.client.download(id, 3)).rejects.toMatchObject({ kind: 'server', status: 416 })
    })

    it('rejects an invalid offset', async () => {
      await expect(h.client.download('x', -1)).rejects.toBeInstanceOf(RangeError)
      await expect(h.client.download('x', 1.5)).rejects.toBeInstanceOf(RangeError)
    })

    it('surfaces a stream error after the headers to the reader instead of retrying', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'abcdefghij')
      h.drive.scriptFailures(h.drive.filePath(id), [{ kind: 'cut', afterBytes: 4 }])
      const stream = await h.client.download(id, 0)
      await expect(readAll(stream)).rejects.toThrow()
      expect(h.drive.requests).toHaveLength(1)
    })

    it('exports a Google document in the requested format', async () => {
      const doc = h.drive.addGoogleDoc(null, 'Doc', { 'application/pdf': 'PDF-BYTES', 'text/plain': 'txt' })
      const bytes = await readAll(await h.client.exportFile(doc, 'application/pdf'))
      expect(bytes.toString()).toBe('PDF-BYTES')
      expect(h.drive.requests[0]?.path).toBe(h.drive.filePath(doc, 'export'))
      expect(h.drive.requests[0]?.query['mimeType']).toBe('application/pdf')
    })

    it('403 exportSizeLimitExceeded on export -> cannot_download', async () => {
      const doc = h.drive.addGoogleDoc(null, 'Doc', { 'application/pdf': 'x' })
      h.drive.scriptFailures(h.drive.filePath(doc, 'export'), [{ status: 403, reason: 'exportSizeLimitExceeded' }])
      await expect(h.client.exportFile(doc, 'application/pdf')).rejects.toMatchObject({
        kind: 'cannot_download',
        message: 'soubor je příliš velký na export z Google Dokumentů',
      })
    })
  })

  describe('abort', () => {
    it('aborts a backoff sleep that would never resolve, with the signal reason', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 503 }])
      const client = new DriveClient({ tokens: staticTokens(), baseUrl: h.drive.baseUrl, sleep: () => new Promise<void>(() => undefined) })
      const controller = new AbortController()
      const pending = client.getItem(id, controller.signal)
      await waitFor(() => h.drive.requests.length === 1)
      controller.abort(new Error('stop now'))
      await expect(pending).rejects.toThrow('stop now')
      expect(h.drive.requests).toHaveLength(1)
    })

    it('aborts the backoff sleep of a download and of listChildren', async () => {
      const file = h.drive.addFile(null, 'a.bin', 'x')
      h.drive.scriptFailures(h.drive.filePath(file), [{ status: 500 }])
      const folder = h.drive.addFolder('F')
      h.drive.scriptFailures((e) => e.path.endsWith('/files'), [{ status: 500 }])
      const client = new DriveClient({ tokens: staticTokens(), baseUrl: h.drive.baseUrl, sleep: () => new Promise<void>(() => undefined) })
      for (const run of [
        (signal: AbortSignal) => client.download(file, 0, signal),
        (signal: AbortSignal) => client.listChildren(folder, signal),
      ]) {
        const controller = new AbortController()
        const before = h.drive.requests.length
        const pending = run(controller.signal)
        await waitFor(() => h.drive.requests.length === before + 1)
        controller.abort()
        const error = await pending.catch((e: unknown) => e)
        expect(error).toBe(controller.signal.reason)
      }
    })

    it('passes the signal to the injected sleep so the default timer can be cleared', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 503 }])
      const seen: (AbortSignal | undefined)[] = []
      const client = new DriveClient({
        tokens: staticTokens(),
        baseUrl: h.drive.baseUrl,
        sleep: (_ms, signal) => {
          seen.push(signal)
          return Promise.resolve()
        },
      })
      const controller = new AbortController()
      await client.getItem(id, controller.signal)
      expect(seen).toEqual([controller.signal])
    })

    it.each([
      ['404', 404, '{"error":{"code":404,"message":"nope","errors":[{"reason":"notFound"}]}}'],
      ['403 cannotDownloadFile', 403, '{"error":{"code":403,"message":"x","errors":[{"reason":"cannotDownloadFile"}]}}'],
      ['401', 401, '{"error":{"code":401,"message":"x","errors":[{"reason":"authError"}]}}'],
    ])('an abort while the %s error body is read surfaces as the abort', async (_name, status, body) => {
      const controller = new AbortController()
      const client = new DriveClient({
        tokens: staticTokens(),
        baseUrl: h.drive.baseUrl,
        fetchFn: () =>
          Promise.resolve({
            ok: false,
            status,
            text: () => {
              controller.abort()
              return Promise.resolve(body)
            },
          } as unknown as Response),
      })
      const error = await client.getItem('x', controller.signal).catch((e: unknown) => e)
      expect(error).toBe(controller.signal.reason)
      expect(error).not.toBeInstanceOf(DriveError)
    })

    it('an abort that makes reading the error body fail also surfaces as the abort', async () => {
      const controller = new AbortController()
      const client = new DriveClient({
        tokens: staticTokens(),
        baseUrl: h.drive.baseUrl,
        fetchFn: () =>
          Promise.resolve({
            ok: false,
            status: 404,
            text: () => {
              controller.abort()
              return Promise.reject(controller.signal.reason)
            },
          } as unknown as Response),
      })
      const error = await client.getItem('x', controller.signal).catch((e: unknown) => e)
      expect(error).toBe(controller.signal.reason)
    })
  })

  describe('abort and the token provider', () => {
    const hang = (): Promise<string> => new Promise<string>(() => undefined)

    it('passes the signal to getAccessToken and refresh', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.acceptTokens('fresh')
      const seen: { get: (AbortSignal | undefined)[]; refresh: (AbortSignal | undefined)[] } = { get: [], refresh: [] }
      const client = new DriveClient({
        tokens: {
          getAccessToken: (signal) => {
            seen.get.push(signal)
            return Promise.resolve('stale')
          },
          refresh: (signal) => {
            seen.refresh.push(signal)
            return Promise.resolve('fresh')
          },
        },
        baseUrl: h.drive.baseUrl,
      })
      const controller = new AbortController()
      await client.getItem(id, controller.signal)
      expect(seen.get).toEqual([controller.signal])
      expect(seen.refresh).toEqual([controller.signal])
    })

    it('a getAccessToken that never resolves does not block an abort', async () => {
      const client = new DriveClient({
        tokens: { getAccessToken: hang, refresh: hang },
        baseUrl: h.drive.baseUrl,
      })
      const controller = new AbortController()
      const pending = client.getItem('x', controller.signal)
      controller.abort(new Error('stop now'))
      const error = await pending.catch((e: unknown) => e)
      expect(error).toBe(controller.signal.reason)
      expect(error).not.toBeInstanceOf(DriveError)
    })

    it('a refresh that never resolves does not block an abort', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.acceptTokens('fresh')
      let refreshStarted = false
      const client = new DriveClient({
        tokens: {
          getAccessToken: () => Promise.resolve('stale'),
          refresh: () => {
            refreshStarted = true
            return hang()
          },
        },
        baseUrl: h.drive.baseUrl,
      })
      const controller = new AbortController()
      const pending = client.getItem(id, controller.signal)
      await waitFor(() => refreshStarted)
      controller.abort(new Error('stop now'))
      await expect(pending).rejects.toBe(controller.signal.reason)
    })

    it('a provider that rejects because of the abort surfaces the abort, not auth', async () => {
      const controller = new AbortController()
      const client = new DriveClient({
        tokens: {
          getAccessToken: (signal) =>
            new Promise<string>((_, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('provider noticed abort')))
            }),
          refresh: hang,
        },
        baseUrl: h.drive.baseUrl,
      })
      const pending = client.getItem('x', controller.signal)
      controller.abort(new Error('stop now'))
      await expect(pending).rejects.toBe(controller.signal.reason)
    })
  })

  describe('token provider failures', () => {
    const failing = (errors: unknown[], thenToken: string): { tokens: TokenProvider; calls: { get: number; refresh: number } } => {
      const calls = { get: 0, refresh: 0 }
      let refreshFailures = [...errors]
      return {
        calls,
        tokens: {
          getAccessToken: () => {
            calls.get += 1
            return Promise.resolve('stale')
          },
          refresh: () => {
            calls.refresh += 1
            const next = refreshFailures.shift()
            return next === undefined ? Promise.resolve(thenToken) : Promise.reject(next)
          },
        },
      }
    }
    const networkError = (): DriveError => new DriveError('network', 'offline')

    it('retries a refresh that throws network twice and then succeeds, with the usual backoff', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.acceptTokens('fresh')
      const { tokens, calls } = failing([networkError(), networkError()], 'fresh')
      const client = new DriveClient({
        tokens,
        baseUrl: h.drive.baseUrl,
        sleep: (ms) => {
          h.sleeps.push(ms)
          return Promise.resolve()
        },
      })
      await expect(client.getItem(id)).resolves.toMatchObject({ id })
      expect(calls.refresh).toBe(3)
      expect(h.sleeps).toEqual([1000, 2000])
      // the pending refresh is not forgotten: only the first request used the stale token
      expect(h.drive.requests.map((r) => r.status)).toEqual([401, 200])
    })

    it('retries getAccessToken that throws network and counts it toward maxRetries', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      let calls = 0
      const client = new DriveClient({
        tokens: {
          getAccessToken: () => {
            calls += 1
            return calls < 3 ? Promise.reject(networkError()) : Promise.resolve('test-token')
          },
          refresh: () => Promise.resolve('test-token'),
        },
        baseUrl: h.drive.baseUrl,
        sleep: (ms) => {
          h.sleeps.push(ms)
          return Promise.resolve()
        },
      })
      await expect(client.getItem(id)).resolves.toMatchObject({ id })
      expect(h.sleeps).toEqual([1000, 2000])
    })

    it('gives up with kind network after maxRetries when the provider always throws network', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      const client = new DriveClient({
        tokens: {
          getAccessToken: () => Promise.reject(networkError()),
          refresh: () => Promise.reject(networkError()),
        },
        baseUrl: h.drive.baseUrl,
        maxRetries: 3,
        sleep: (ms) => {
          h.sleeps.push(ms)
          return Promise.resolve()
        },
      })
      const error = await client.getItem(id).catch((e: unknown) => e)
      expect(error).toMatchObject({ kind: 'network' })
      expect(h.sleeps).toEqual([1000, 2000, 4000])
      expect(h.drive.requests).toHaveLength(0)
    })

    it('shares the retry budget between token failures and HTTP failures', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 503 }, { status: 503 }, { status: 503 }])
      let calls = 0
      const client = new DriveClient({
        tokens: {
          getAccessToken: () => {
            calls += 1
            return calls === 1 ? Promise.reject(networkError()) : Promise.resolve('test-token')
          },
          refresh: () => Promise.resolve('test-token'),
        },
        baseUrl: h.drive.baseUrl,
        maxRetries: 2,
        sleep: () => Promise.resolve(),
      })
      await expect(client.getItem(id)).rejects.toMatchObject({ kind: 'server' })
      expect(h.drive.requests).toHaveLength(2)
    })

    it('a provider that throws auth fails immediately with kind auth', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      const authError = new DriveError('auth', 'grant revoked')
      const client = new DriveClient({
        tokens: { getAccessToken: () => Promise.reject(authError), refresh: () => Promise.reject(authError) },
        baseUrl: h.drive.baseUrl,
        sleep: (ms) => {
          h.sleeps.push(ms)
          return Promise.resolve()
        },
      })
      await expect(client.getItem(id)).rejects.toBe(authError)
      expect(h.sleeps).toEqual([])
      expect(h.drive.requests).toHaveLength(0)
    })

    it('a refresh that throws auth after a 401 fails immediately', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.acceptTokens('fresh')
      const { tokens } = failing([new DriveError('auth', 'invalid_grant')], 'fresh')
      const client = new DriveClient({ tokens, baseUrl: h.drive.baseUrl, sleep: () => Promise.resolve() })
      await expect(client.getItem(id)).rejects.toMatchObject({ kind: 'auth' })
      expect(h.drive.requests).toHaveLength(1)
    })

    it('other thrown errors still map to auth', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      const client = new DriveClient({
        tokens: { getAccessToken: () => Promise.reject(new Error('boom')), refresh: () => Promise.reject(new Error('boom')) },
        baseUrl: h.drive.baseUrl,
      })
      await expect(client.getItem(id)).rejects.toMatchObject({ kind: 'auth' })
    })
  })

  describe('pagination guard', () => {
    it('collects every item when pages are empty or short but still carry a nextPageToken', async () => {
      const folder = h.drive.addFolder('F')
      const ids = h.drive.addFiles(folder, 10)
      h.drive.pageSizes = [0, 3, 0, 1, 1000]
      const items = await h.client.listChildren(folder)
      expect(items.map((i) => i.id)).toEqual(ids)
      expect(h.drive.requests.length).toBeGreaterThanOrEqual(5)
    })

    it('stops on an empty nextPageToken', async () => {
      const folder = h.drive.addFolder('F')
      const file = h.drive.addFile(folder, 'a.txt', 'x')
      h.drive.scriptFailures(
        (e) => e.path.endsWith('/files'),
        [{ status: 200, body: JSON.stringify({ nextPageToken: '', files: [fileResource(file)] }) }],
      )
      const items = await h.client.listChildren(folder)
      expect(items.map((i) => i.id)).toEqual([file])
      expect(h.drive.requests).toHaveLength(1)
    })

    it('throws kind server when the same token comes back', async () => {
      const folder = h.drive.addFolder('F')
      const body = JSON.stringify({ nextPageToken: 'same', files: [] })
      h.drive.scriptFailures((e) => e.path.endsWith('/files'), [{ status: 200, body }, { status: 200, body }, { status: 200, body }])
      const error = await h.client.listChildren(folder).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DriveError)
      expect(error).toMatchObject({ kind: 'server' })
      expect(h.drive.requests).toHaveLength(2)
    })
  })

  describe('status mapping', () => {
    it('retries 408 like a 5xx', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 408 }])
      await expect(h.client.getItem(id)).resolves.toMatchObject({ id })
      expect(h.sleeps).toEqual([1000])

      h.drive.scriptFailures(h.drive.filePath(id), Array.from({ length: 10 }, () => ({ status: 408 })))
      await expect(h.makeClient(1).getItem(id)).rejects.toMatchObject({ kind: 'server', status: 408 })
    })

    it('403 downloadQuotaExceeded -> cannot_download with its own message, no retry', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 403, reason: 'downloadQuotaExceeded' }])
      h.sleeps.length = 0
      const error = await h.client.download(id, 0).catch((e: unknown) => e)
      expect(error).toMatchObject({
        kind: 'cannot_download',
        status: 403,
        message: 'Google dočasně omezil stahování tohoto souboru, zkus to později',
      })
      expect(h.drive.requests).toHaveLength(1)
      expect(h.sleeps).toEqual([])
    })

    it('retries 403 sharingRateLimitExceeded like rateLimitExceeded', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 403, reason: 'sharingRateLimitExceeded' }])
      await expect(h.client.getItem(id)).resolves.toMatchObject({ id })
      expect(h.sleeps).toEqual([1000])
    })

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('constructor rejects maxRetries %s', (maxRetries) => {
      expect(() => new DriveClient({ tokens: staticTokens(), maxRetries })).toThrow(RangeError)
    })

    it('constructor accepts maxRetries 0 and then never retries', async () => {
      const id = h.drive.addFile(null, 'a.txt', 'x')
      h.drive.scriptFailures(h.drive.filePath(id), [{ status: 503 }])
      await expect(h.makeClient(0).getItem(id)).rejects.toMatchObject({ kind: 'server' })
      expect(h.sleeps).toEqual([])
    })
  })

  describe('connection release', () => {
    /** The fake sends the headers and the first chunk, then holds the body open for a minute. */
    const holdBodyOpen = (): void => {
      h.drive.chunkSize = 100
      h.drive.chunkDelayMs = 60_000
    }

    it('closes the connection after a 200 to a Range request, even though the server holds the body open', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'x'.repeat(5000))
      h.drive.ignoreRange = true
      holdBodyOpen()
      await expect(h.client.download(id, 10)).rejects.toMatchObject({ kind: 'server', status: 200 })
      await waitFor(() => h.drive.activeDownloads === 0, 500)
    })

    it('closes the connection after a 206 at the wrong offset, even though the server holds the body open', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'x'.repeat(5000))
      holdBodyOpen()
      // the fake answers a correct 206; this client's fetch rewrites Content-Range to simulate the wrong offset
      const client = new DriveClient({
        tokens: staticTokens(),
        baseUrl: h.drive.baseUrl,
        fetchFn: async (input, init) => {
          const res = await fetch(input, init)
          return new Response(res.body, { status: 206, headers: { 'content-range': 'bytes 0-4999/5000' } })
        },
      })
      await expect(client.download(id, 10)).rejects.toMatchObject({ kind: 'server', status: 206 })
      await waitFor(() => h.drive.activeDownloads === 0, 500)
    })

    it('an abort while the body is streaming errors the stream with the abort and closes the connection', async () => {
      const id = h.drive.addFile(null, 'a.bin', 'x'.repeat(5000))
      holdBodyOpen()
      const controller = new AbortController()
      const stream = await h.client.download(id, 0, controller.signal)
      const reader = stream.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(h.drive.activeDownloads).toBe(1)
      controller.abort(new Error('stop streaming'))
      const error = await reader.read().catch((e: unknown) => e)
      expect(error).toBe(controller.signal.reason)
      await waitFor(() => h.drive.activeDownloads === 0, 500)
    })
  })

  describe('shared drives', () => {
    it('still sees items that only exist for supportsAllDrives=true requests', async () => {
      const folder = h.drive.addFolder('Shared', null, { sharedDrive: true })
      const file = h.drive.addFile(folder, 'a.txt', 'hello', { sharedDrive: true })
      expect(await h.client.getItem(folder)).toMatchObject({ id: folder })
      expect((await h.client.listChildren(folder)).map((i) => i.id)).toEqual([file])
      expect(await readAll(await h.client.download(file, 0))).toEqual(Buffer.from('hello'))
      expect(await readAll(await h.client.download(file, 2))).toEqual(Buffer.from('llo'))
    })
  })
})

function staticTokens(token = 'test-token'): TokenProvider {
  return { getAccessToken: () => Promise.resolve(token), refresh: () => Promise.resolve(token) }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function fileResource(id: string): Record<string, unknown> {
  return {
    id,
    name: 'a.txt',
    mimeType: 'text/plain',
    size: '1',
    md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
    createdTime: '2026-01-01T10:00:00.000Z',
    modifiedTime: '2026-01-02T10:00:00.000Z',
    capabilities: { canDownload: true },
  }
}
