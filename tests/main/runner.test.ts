import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Classifier } from '../../src/core/classifier'
import type { RunEvent, RunOptions, RunSummary } from '../../src/core/pipeline'
import { describeCard } from '../../src/main/cardinfo'
import { FINAL_OK_MESSAGE, NOT_BACKED_UP, Runner, listEvents, noticeFor, type Notice, type RunnerDeps } from '../../src/main/runner'
import { defaultSettings } from '../../src/main/settings'
import type { RunEventPayload, Settings } from '../../src/shared/ipc-types'

const SUMMARY: RunSummary = {
  perFolder: {},
  top: 0,
  markers: 0,
  orphanMarkers: 0,
  unclassified: 0,
  lowConfidence: [],
  alreadyUploaded: 0,
  verifyFailed: [],
  others: 0,
  costUsd: 0,
  csvPath: '',
  status: 'ok',
  ai: 'used',
}

let base: string
let rootDir: string
let cardRoot: string
let settings: Settings
let apiKey: string | null
let sent: RunEventPayload[]
let notices: Notice[]
let runs: RunOptions[]
let runImpl: (opts: RunOptions, onEvent: (e: RunEvent) => void) => Promise<RunSummary>

function makeRunner(over: Partial<RunnerDeps> = {}): Runner {
  const r = new Runner({
    getSettings: async () => settings,
    getApiKey: async () => apiKey,
    journalFile: path.join(base, 'journal.jsonl'),
    send: (p) => sent.push(p),
    notify: (n) => notices.push(n),
    makeClassifier: (): Classifier => ({ classify: async () => { throw new Error('unused') } }),
    run: async (opts, onEvent) => {
      runs.push(opts)
      return runImpl(opts, onEvent)
    },
    ...over,
  })
  r.registerCard(cardRoot)
  return r
}

const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  cardRoot,
  eventName: 'Sparta - Slavia',
  isNew: true,
  templateId: 'fotbal',
  rosterText: '9 Kačor\n10 Provod',
  ...over,
})

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-runner-'))
  rootDir = path.join(base, 'drive')
  cardRoot = path.join(base, 'SONY')
  await fs.mkdir(rootDir)
  await fs.mkdir(path.join(cardRoot, 'PRIVATE', 'M4ROOT', 'CLIP'), { recursive: true })
  settings = { ...defaultSettings(), rootDir }
  apiKey = 'sk-test'
  sent = []
  notices = []
  runs = []
  runImpl = async (_o, onEvent) => {
    onEvent({ type: 'done', summary: SUMMARY })
    return SUMMARY
  }
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('Runner.start refusals', () => {
  it('refuses without a root folder', async () => {
    settings = { ...settings, rootDir: null }
    const res = await makeRunner().start(request())
    expect(res).toMatchObject({ ok: false })
    expect(res.ok === false && res.error).toMatch(/složku/)
    expect(runs).toHaveLength(0)
  })

  it('refuses when the root folder is missing, and does not recreate it', async () => {
    await fs.rm(rootDir, { recursive: true })
    const res = await makeRunner().start(request())
    expect(res.ok).toBe(false)
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses without an API key', async () => {
    apiKey = null
    const res = await makeRunner().start(request())
    expect(res.ok === false && res.error).toMatch(/klíč/)
    await expect(fs.stat(path.join(rootDir, 'Sparta - Slavia'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a new event whose folder already exists and leaves it untouched', async () => {
    await fs.mkdir(path.join(rootDir, 'Sparta - Slavia'))
    await fs.writeFile(path.join(rootDir, 'Sparta - Slavia', 'keep.txt'), 'x')
    const res = await makeRunner().start(request())
    expect(res.ok === false && res.error).toMatch(/už existuje/)
    expect(await fs.readdir(path.join(rootDir, 'Sparta - Slavia'))).toEqual(['keep.txt'])
    expect(runs).toHaveLength(0)
  })

  it('refuses an existing event that is not there', async () => {
    const res = await makeRunner().start(request({ isNew: false }))
    expect(res.ok === false && res.error).toMatch(/neexistuje/)
    await expect(fs.stat(path.join(rootDir, 'Sparta - Slavia'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an existing event that is a symlink (the pipeline would treat it as a vanished folder)', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    await fs.mkdir(elsewhere)
    await fs.symlink(elsewhere, path.join(rootDir, 'Sparta - Slavia'))
    const res = await makeRunner().start(request({ isNew: false }))
    expect(res.ok === false && res.error).toMatch(/odkaz|symbolick/)
    expect(runs).toHaveLength(0)
  })

  it('refuses an existing event that is a regular file', async () => {
    await fs.writeFile(path.join(rootDir, 'Sparta - Slavia'), 'x')
    const res = await makeRunner().start(request({ isNew: false }))
    expect(res.ok).toBe(false)
  })

  it.each(['../evil', 'a/b', '..', '.hidden', '  ', 'a\\b'])('refuses the event name %j', async (eventName) => {
    const res = await makeRunner().start(request({ eventName }))
    expect(res.ok).toBe(false)
    expect(runs).toHaveLength(0)
    expect(await fs.readdir(rootDir)).toEqual([])
  })

  it('refuses an unknown template, an unknown card and malformed requests', async () => {
    const runner = makeRunner()
    expect((await runner.start(request({ templateId: 'nope' }))).ok).toBe(false)
    expect((await runner.start(request({ cardRoot: path.join(base, 'OTHER') }))).ok).toBe(false)
    expect((await runner.start({ cardRoot })).ok).toBe(false)
    expect((await runner.start(null)).ok).toBe(false)
    expect(await fs.readdir(rootDir)).toEqual([])
  })

  it('refuses a card that overlaps the root folder', async () => {
    const inside = path.join(rootDir, 'Old')
    await fs.mkdir(inside)
    const runner = makeRunner()
    runner.registerCard(inside)
    const res = await runner.start(request({ cardRoot: inside }))
    expect(res.ok === false && res.error).toMatch(/překrývají/)
  })

  it('refuses the same card twice while it is queued', async () => {
    let release: () => void = () => {}
    runImpl = () =>
      new Promise<RunSummary>((resolve) => {
        release = () => resolve(SUMMARY)
      })
    const runner = makeRunner()
    expect((await runner.start(request())).ok).toBe(true)
    const again = await runner.start(request({ eventName: 'Jina akce' }))
    expect(again.ok === false && again.error).toMatch(/už zálohuje/)
    while (runs.length === 0) await new Promise((r) => setTimeout(r, 5)) // the job has started and waits for release
    release()
    await runner.idle()
    runImpl = async () => SUMMARY
    expect((await runner.start(request({ eventName: 'Jina akce' }))).ok).toBe(true) // free again afterwards
    await runner.idle()
  })
})

describe('Runner.start', () => {
  it('creates the event folder (non-recursive), runs the pipeline and forwards events', async () => {
    const runner = makeRunner()
    expect(await runner.start(request())).toEqual({ ok: true })
    await runner.idle()
    const eventDir = path.join(rootDir, 'Sparta - Slavia')
    expect((await fs.stat(eventDir)).isDirectory()).toBe(true)
    expect(runs).toHaveLength(1)
    const opts = runs[0]!
    expect(opts.eventDir).toBe(eventDir)
    expect(opts.cardRoot).toBe(cardRoot)
    expect(opts.template.id).toBe('fotbal')
    expect(opts.roster).toEqual([
      { number: 9, surname: 'Kačor' },
      { number: 10, surname: 'Provod' },
    ])
    expect(opts.markerOpts).toEqual({ lumaThreshold: 0.2 })
    expect(typeof opts.waitForSpace).toBe('function')
    expect(sent.map((p) => p.event.type)).toEqual(['queued', 'started', 'done'])
    expect(sent.every((p) => p.cardRoot === cardRoot)).toBe(true)
  })

  it('adds to an existing event folder when isNew is false', async () => {
    const eventDir = path.join(rootDir, 'Sparta - Slavia')
    await fs.mkdir(eventDir)
    const runner = makeRunner()
    expect(await runner.start(request({ isNew: false }))).toEqual({ ok: true })
    await runner.idle()
    expect(runs[0]!.eventDir).toBe(eventDir)
  })

  it('uses the model from settings for the classifier', async () => {
    settings = { ...settings, model: 'claude-haiku-5-5' }
    let seen = ''
    const runner = makeRunner({
      makeClassifier: (_key, model): Classifier => {
        seen = model
        return { classify: async () => { throw new Error('unused') } }
      },
    })
    await runner.start(request())
    await runner.idle()
    expect(seen).toBe('claude-haiku-5-5')
  })

  it('forwards waiting_space from the space waiter', async () => {
    runImpl = async (opts, onEvent) => {
      // ask for more bytes than any disk has: the waiter must announce waiting once
      const waiting = opts.waitForSpace!(Number.MAX_SAFE_INTEGER)
      await new Promise((r) => setTimeout(r, 100))
      onEvent({ type: 'done', summary: SUMMARY })
      void waiting.catch(() => {})
      return SUMMARY
    }
    const runner = makeRunner()
    await runner.start(request())
    await runner.idle()
    expect(sent.some((p) => p.event.type === 'waiting_space')).toBe(true)
  })

  it('runs two cards one after another and reports the queue position', async () => {
    const card2 = path.join(base, 'CANON')
    await fs.mkdir(card2)
    const order: string[] = []
    runImpl = async (opts) => {
      order.push(`start ${path.basename(opts.cardRoot)}`)
      await new Promise((r) => setTimeout(r, 30))
      order.push(`end ${path.basename(opts.cardRoot)}`)
      return SUMMARY
    }
    const runner = makeRunner()
    runner.registerCard(card2)
    await runner.start(request())
    await runner.start(request({ cardRoot: card2, eventName: 'Druha' }))
    await runner.idle()
    expect(order).toEqual(['start SONY', 'end SONY', 'start CANON', 'end CANON'])
    const queued = sent.filter((p) => p.event.type === 'queued').map((p) => (p.event.type === 'queued' ? p.event.position : -1))
    expect(queued).toEqual([0, 1])
  })

  it('reports a pipeline exception to the renderer and in a notification, and frees the card', async () => {
    runImpl = async () => {
      throw new Error('disk exploded')
    }
    const runner = makeRunner()
    await runner.start(request())
    await runner.idle()
    expect(sent.at(-1)).toEqual({ cardRoot, event: { type: 'failed', message: 'disk exploded' } })
    expect(notices).toHaveLength(1)
    expect(notices[0]!.title).toBe(NOT_BACKED_UP)
    runImpl = async () => SUMMARY
    expect((await runner.start(request({ eventName: 'Znovu' }))).ok).toBe(true)
    await runner.idle()
  })

  it('notifies once when the run finishes', async () => {
    const runner = makeRunner()
    await runner.start(request())
    await runner.idle()
    expect(notices).toEqual([{ title: 'Třídění karet', body: FINAL_OK_MESSAGE }])
  })

  it('never puts the API key into events or notices', async () => {
    const runner = makeRunner()
    await runner.start(request())
    await runner.idle()
    expect(JSON.stringify([sent, notices])).not.toContain('sk-test')
  })
})

describe('noticeFor', () => {
  it('uses the fixed warning for every outcome except ok', () => {
    expect(noticeFor({ ...SUMMARY, status: 'ok' }).body).toBe(FINAL_OK_MESSAGE)
    for (const status of ['card_removed', 'verify_failed', 'aborted'] as const) {
      expect(noticeFor({ ...SUMMARY, status }).title).toBe('Karta ještě NENÍ zálohovaná')
    }
  })
})

describe('listEvents', () => {
  it('lists only visible subfolders, newest first', async () => {
    await fs.mkdir(path.join(rootDir, 'Stara'))
    await fs.mkdir(path.join(rootDir, 'Nova'))
    await fs.mkdir(path.join(rootDir, '.skryta'))
    await fs.writeFile(path.join(rootDir, 'soubor.txt'), 'x')
    const old = new Date('2020-01-01')
    await fs.utimes(path.join(rootDir, 'Stara'), old, old)
    expect(await listEvents(rootDir)).toEqual(['Nova', 'Stara'])
  })

  it('returns an empty list for a missing or unset root', async () => {
    expect(await listEvents(null)).toEqual([])
    expect(await listEvents(path.join(base, 'nope'))).toEqual([])
  })
})

describe('describeCard', () => {
  it('counts videos and bytes and reports first/last file times without probing', async () => {
    const clip = path.join(cardRoot, 'PRIVATE', 'M4ROOT', 'CLIP')
    await fs.writeFile(path.join(clip, 'C0001.MP4'), Buffer.alloc(100))
    await fs.writeFile(path.join(clip, 'C0002.MP4'), Buffer.alloc(50))
    await fs.writeFile(path.join(clip, 'C0001M01.XML'), Buffer.alloc(10))
    await fs.utimes(path.join(clip, 'C0001.MP4'), new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'))
    await fs.utimes(path.join(clip, 'C0002.MP4'), new Date('2026-10-02T12:00:00Z'), new Date('2026-10-02T12:00:00Z'))
    expect(await describeCard(cardRoot)).toEqual({
      root: cardRoot,
      volumeName: 'SONY',
      videos: 2,
      bytes: 160,
      firstDate: '2026-10-01T10:00:00.000Z',
      lastDate: '2026-10-02T12:00:00.000Z',
    })
  })

  it('handles a card without videos and an unreadable card', async () => {
    expect(await describeCard(cardRoot)).toMatchObject({ videos: 0, bytes: 0, firstDate: null, lastDate: null })
    expect(await describeCard(path.join(base, 'gone'))).toBeNull()
  })
})
