import { execFile } from 'node:child_process'
import { createReadStream, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../../src/core/bin'
import type { Classifier, ClassifyInput, ClassifyResult } from '../../src/core/classifier'
import { sha256File } from '../../src/core/copy'
import { Journal } from '../../src/core/journal'
import { ANALYSIS_FAILED, runCard, type RunEvent, type RunOptions, type RunSummary } from '../../src/core/pipeline'
import { DEFAULT_TEMPLATES } from '../../src/core/templates'
import { ensureFixtureClips } from '../fixtures/make-clips'

const TEMPLATE = DEFAULT_TEMPLATES[0]!
const CLIP_DIR = 'PRIVATE/M4ROOT/CLIP'
const SONNET_USAGE = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, model: 'claude-sonnet-5-5' }

let work: string
let clips: { c1: string; c1b: string; c2: string; c3: string }
let root: string
let cardRoot: string
let eventDir: string
let journalFile: string

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 60_000 }, (err, _o, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${stderr.slice(-400)}`))
      else resolve()
    })
  })
}

/** Remuxes a fixture with a creation_time so that marker/TOP detection has real timestamps. */
async function dated(src: string, name: string, iso: string): Promise<string> {
  const out = path.join(work, name)
  await ffmpeg(['-i', src, '-c', 'copy', '-metadata', `creation_time=${iso}`, '-f', 'mp4', out])
  return out
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-pipeline-clips-'))
  const f = await ensureFixtureClips()
  clips = {
    c1: await dated(f.bright, 'c1.mp4', '2026-10-01T10:00:00Z'), // 5 s, ends 10:00:05
    c1b: await dated(f.bright, 'c1b.mp4', '2026-10-01T10:00:01Z'), // same size as c1, different bytes
    c2: await dated(f.black, 'c2.mp4', '2026-10-01T10:00:07Z'), // marker, 2 s after c1 ended
    c3: await dated(f.bright, 'c3.mp4', '2026-10-01T10:05:00Z'),
  }
})

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

async function put(rel: string, content: Buffer | string | { copyFrom: string }, at: string = cardRoot): Promise<void> {
  const abs = path.join(at, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  if (typeof content === 'object' && 'copyFrom' in content) await fs.copyFile(content.copyFrom, abs)
  else await fs.writeFile(abs, content)
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-pipeline-'))
  cardRoot = path.join(root, 'SONY')
  eventDir = path.join(root, 'drive', 'Akce')
  journalFile = path.join(root, 'journal.jsonl')
  await fs.mkdir(eventDir, { recursive: true }) // the pipeline never creates the event folder itself
  await put(`${CLIP_DIR}/C0001.MP4`, { copyFrom: clips.c1 })
  await put(`${CLIP_DIR}/C0002.MP4`, { copyFrom: clips.c2 })
  await put(`${CLIP_DIR}/C0003.MP4`, { copyFrom: clips.c3 })
  await put(`${CLIP_DIR}/C0001M01.XML`, '<NonRealTimeMeta/>')
  await put('DCIM/100MSDCF/DSC00001.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await put(`${CLIP_DIR}/._C0001.MP4`, 'appledouble')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function fakeClassifier(overrides: Record<string, ClassifyResult> = {}): Classifier & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async classify(input: ClassifyInput): Promise<ClassifyResult> {
      seen.push(input.fileName)
      const o = overrides[input.fileName]
      if (o) return o
      const description = input.fileName.startsWith('C0001') ? 'gol' : 'sance'
      return { category: 'Zápas', description, confidence: 'high', ok: true, usage: SONNET_USAGE }
    },
  }
}

async function baseOptions(over: Partial<RunOptions> = {}): Promise<RunOptions> {
  return {
    cardRoot,
    eventDir,
    template: TEMPLATE,
    roster: [],
    classifier: fakeClassifier(),
    journal: await Journal.load(journalFile),
    waitForSpace: async () => {},
    ...over,
  }
}

async function run(over: Partial<RunOptions> = {}, signal?: AbortSignal): Promise<{ summary: RunSummary; events: RunEvent[] }> {
  const events: RunEvent[] = []
  const summary = await runCard(await baseOptions(over), (e) => events.push(e), signal)
  await expectNoAnalysisFailure(summary)
  return { summary, events }
}

/**
 * None of these tests makes probing / frame sampling fail on purpose. If a clip still lands in
 * _nezařazeno with this note, ffprobe/ffmpeg failed transiently (e.g. timed out under load, Ruling 20).
 */
async function expectNoAnalysisFailure(summary: RunSummary): Promise<void> {
  const texts = [...summary.verifyFailed]
  if (summary.csvPath !== '') texts.push(await fs.readFile(summary.csvPath, 'utf8'))
  expect(texts.join('\n'), 'clip analysis (ffprobe/ffmpeg) failed in a test that does not provoke it').not.toContain(ANALYSIS_FAILED)
}

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)))
    else out.push(r)
  }
  return out.sort()
}

const media = (files: string[]): string[] => files.filter((f) => !f.startsWith('_trideni_'))

async function readCsv(p: string): Promise<string[][]> {
  const text = await fs.readFile(p, 'utf8')
  expect(text.charCodeAt(0)).toBe(0xfeff)
  return text
    .slice(1)
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .map((l) => l.split(';'))
}

function enoent(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error('ENOENT: card removed')
  e.code = 'ENOENT'
  return e
}

describe('runCard', () => {
  it('sorts a card into the event folder and writes the mapping CSV', { timeout: 120_000 }, async () => {
    const { summary, events } = await run()

    expect(media(await listFiles(eventDir))).toEqual([
      'Zápas/C0001_TOP_gol.MP4',
      'Zápas/C0003_sance.MP4',
      '_ostatni/DCIM/100MSDCF/DSC00001.JPG',
      `_ostatni/${CLIP_DIR}/C0001M01.XML`,
    ])
    expect(await sha256File(path.join(eventDir, 'Zápas/C0001_TOP_gol.MP4'))).toBe(await sha256File(clips.c1))

    expect(summary).toMatchObject({
      top: 1,
      markers: 1,
      orphanMarkers: 0,
      others: 2,
      unclassified: 0,
      alreadyUploaded: 0,
      verifyFailed: [],
      lowConfidence: [],
      status: 'ok',
      perFolder: { Zápas: 2 },
    })
    expect(summary.costUsd).toBeCloseTo(4, 6)
    expect(path.dirname(summary.csvPath)).toBe(eventDir)
    expect(path.basename(summary.csvPath)).toMatch(/^_trideni_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.csv$/)

    const rows = await readCsv(summary.csvPath)
    expect(rows[0]).toEqual(['puvodni_nazev', 'novy_nazev', 'slozka', 'poznamka'])
    expect(rows).toHaveLength(6) // header + 5 files; the ._ file is not listed
    const byName = new Map(rows.slice(1).map((r) => [r[0], r]))
    expect(byName.get('C0001.MP4')).toMatchObject({ 1: 'C0001_TOP_gol.MP4', 2: 'Zápas' })
    expect(byName.get('C0002.MP4')?.[2]).toBe('(nekopírováno)')
    expect(byName.get('C0002.MP4')?.[3]).toContain('černá značka')
    expect(byName.get('C0001M01.XML')?.[2]).toBe(`_ostatni/${CLIP_DIR}`)

    expect(events[0]).toMatchObject({ type: 'scanned', videos: 3, others: 2 })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(events.filter((e) => e.type === 'copied')).toHaveLength(4)
    const tops = events.filter((e) => e.type === 'classified' && e.top)
    expect(tops.map((e) => e.type === 'classified' && e.relPath)).toEqual([`${CLIP_DIR}/C0001.MP4`])
  })

  it('classifies only non-marker clips', { timeout: 120_000 }, async () => {
    const classifier = fakeClassifier()
    await run({ classifier })
    expect([...classifier.seen].sort()).toEqual(['C0001.MP4', 'C0003.MP4'])
  })

  it('puts a clip whose classification failed into _nezařazeno under its original name', { timeout: 120_000 }, async () => {
    const failed: ClassifyResult = { category: '_nezařazeno', description: '', confidence: 'low', ok: false, error: 'API down' }
    const { summary } = await run({ classifier: fakeClassifier({ 'C0003.MP4': failed }) })
    expect(media(await listFiles(eventDir))).toContain('_nezařazeno/C0003.MP4')
    expect(summary.unclassified).toBe(1)
    expect(summary.perFolder).toEqual({ Zápas: 1, _nezařazeno: 1 })
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[3]).toContain('API down')
  })

  it('keeps the TOP marking of a TOP clip whose classification failed', { timeout: 120_000 }, async () => {
    const failed: ClassifyResult = { category: '_nezařazeno', description: '', confidence: 'low', ok: false, error: 'API down' }
    const { summary } = await run({ classifier: fakeClassifier({ 'C0001.MP4': failed }) })
    const files = media(await listFiles(eventDir))
    expect(files).toContain('_nezařazeno/C0001_TOP.MP4')
    expect(files).not.toContain('_nezařazeno/C0001.MP4')
    expect(files).toContain('Zápas/C0003_sance.MP4') // non-TOP clips are unaffected
    expect(summary.top).toBe(1)
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0001.MP4')?.[1]).toBe('C0001_TOP.MP4')
  })

  describe('when the AI is unavailable', () => {
    /** Five clips that are neither markers nor TOP: c3 copies, one minute apart. */
    async function fiveMoreClips(): Promise<void> {
      for (let i = 4; i <= 8; i++) await put(`${CLIP_DIR}/C000${i}.MP4`, { copyFrom: clips.c3 })
    }
    function throwingClassifier(): Classifier & { calls: number } {
      const c = {
        calls: 0,
        async classify(): Promise<ClassifyResult> {
          c.calls++
          throw new Error('connect ETIMEDOUT')
        },
      }
      return c
    }

    it('stops calling the classifier after 5 consecutive API failures and still backs everything up', { timeout: 120_000 }, async () => {
      await fiveMoreClips() // 7 clips to classify in total
      const classifier = throwingClassifier()
      const { summary } = await run({ classifier, concurrency: 1 })

      expect(classifier.calls).toBe(5)
      expect(summary.ai).toBe('unavailable')
      expect(summary.status).toBe('ok')
      expect(summary.unclassified).toBe(7)
      expect(summary.verifyFailed).toEqual([])
      const files = media(await listFiles(eventDir))
      expect(files).toContain('_nezařazeno/C0001_TOP.MP4') // TOP name kept (Ruling 17)
      for (const n of [3, 4, 5, 6, 7, 8]) expect(files).toContain(`_nezařazeno/C000${n}.MP4`)
      expect(files).toContain('_ostatni/DCIM/100MSDCF/DSC00001.JPG')
      const notes = (await readCsv(summary.csvPath)).map((r) => r.slice(3).join(';')) // a note may itself contain ';'
      expect(notes.filter((n) => n.includes('connect ETIMEDOUT'))).toHaveLength(5)
      expect(notes.filter((n) => n.includes('AI nedostupná'))).toHaveLength(2)
    })

    it('never makes more than 5 + (parallel - 1) calls when classifying in parallel', { timeout: 120_000 }, async () => {
      await fiveMoreClips()
      for (let i = 10; i <= 15; i++) await put(`${CLIP_DIR}/C00${i}.MP4`, { copyFrom: clips.c3 })
      const classifier = throwingClassifier()
      const { summary } = await run({ classifier, concurrency: 4 })
      expect(classifier.calls).toBeGreaterThanOrEqual(5)
      expect(classifier.calls).toBeLessThanOrEqual(8)
      expect(summary.ai).toBe('unavailable')
      expect(summary.status).toBe('ok')
      expect(summary.unclassified).toBe(13)
    })

    it('counts only consecutive API failures: a success or a refusal resets the count', { timeout: 120_000 }, async () => {
      await fiveMoreClips()
      for (let i = 10; i <= 12; i++) await put(`${CLIP_DIR}/C00${i}.MP4`, { copyFrom: clips.c3 })
      let calls = 0
      const classifier: Classifier = {
        async classify(input) {
          calls++
          // every 4th call answers (a refusal: ok:false but not an API failure), the others fail
          if (calls % 4 === 0) return { category: '_nezařazeno', description: '', confidence: 'low', ok: false, error: 'Model odmítl klip zpracovat' }
          return { category: '_nezařazeno', description: '', confidence: 'low', ok: false, error: `down ${input.fileName}`, apiFailure: true }
        },
      }
      const { summary } = await run({ classifier, concurrency: 1 })
      expect(calls).toBe(10) // 10 clips, never 5 failures in a row
      expect(summary.ai).toBe('used')
    })

    it('reports the AI as used on a normal run', { timeout: 120_000 }, async () => {
      const { summary } = await run()
      expect(summary.ai).toBe('used')
    })
  })

  it('backs up without sorting when there is no classifier: everything in _nezařazeno, markers and TOP still detected', { timeout: 120_000 }, async () => {
    const { summary, events } = await run({ classifier: null })
    expect(media(await listFiles(eventDir))).toEqual([
      '_nezařazeno/C0001_TOP.MP4',
      '_nezařazeno/C0003.MP4',
      '_ostatni/DCIM/100MSDCF/DSC00001.JPG',
      `_ostatni/${CLIP_DIR}/C0001M01.XML`,
    ])
    expect(await sha256File(path.join(eventDir, '_nezařazeno/C0001_TOP.MP4'))).toBe(await sha256File(clips.c1))
    expect(summary).toMatchObject({ top: 1, markers: 1, unclassified: 2, status: 'ok', ai: 'off', costUsd: 0, verifyFailed: [] })
    const rows = await readCsv(summary.csvPath)
    const note = (name: string): string => rows.find((r) => r[0] === name)?.slice(3).join(';') ?? ''
    expect(note('C0001.MP4')).toContain('bez třídění')
    expect(note('C0001.MP4')).not.toContain('selhala')
    expect(note('C0002.MP4')).toContain('černá značka')
    expect(events.filter((e) => e.type === 'classified' && !e.marker)).toHaveLength(2)
  })

  it('reports low-confidence clips', { timeout: 120_000 }, async () => {
    const low: ClassifyResult = { category: 'Zápas', description: 'sance', confidence: 'low', ok: true }
    const { summary } = await run({ classifier: fakeClassifier({ 'C0003.MP4': low }) })
    expect(summary.lowConfidence).toEqual([`${CLIP_DIR}/C0003.MP4`])
  })

  it('never uses a category that is not a plain folder name', { timeout: 120_000 }, async () => {
    const evil: ClassifyResult = { category: '../../x', description: 'sance', confidence: 'high', ok: true }
    const { summary } = await run({ classifier: fakeClassifier({ 'C0003.MP4': evil }) })
    expect(media(await listFiles(eventDir))).toContain('_nezařazeno/C0003_sance.MP4')
    expect(summary.unclassified).toBe(1)
    expect((await listFiles(root)).some((f) => f.includes('x/'))).toBe(false)
  })

  it('does nothing new on a second run with the same journal and does not classify again', { timeout: 120_000 }, async () => {
    const journal = await Journal.load(journalFile)
    const first = await run({ journal })
    const before = media(await listFiles(eventDir))
    const classifier = fakeClassifier()
    const second = await run({ journal, classifier })

    expect(media(await listFiles(eventDir))).toEqual(before)
    expect(second.summary.alreadyUploaded).toBe(4)
    expect(second.summary.status).toBe('ok')
    expect(second.summary.perFolder).toEqual({ Zápas: 2 })
    expect(classifier.seen).toEqual([])
    expect(second.summary.csvPath).not.toBe(first.summary.csvPath) // add-only: a new CSV, never overwritten
    expect(await fs.readFile(first.summary.csvPath, 'utf8')).toContain('C0001_TOP_gol.MP4')
    const rows = await readCsv(second.summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')).toMatchObject({ 1: 'C0003_sance.MP4', 2: 'Zápas' })
  })

  it('counts content-identical files at the destination as already uploaded', { timeout: 120_000 }, async () => {
    await run()
    // a fresh journal (e.g. another machine) knows nothing; the copy step finds identical files
    await fs.rm(journalFile)
    const { summary } = await run({ journal: await Journal.load(journalFile) })
    expect(summary.alreadyUploaded).toBe(4)
    expect(media(await listFiles(eventDir))).toHaveLength(4)
  })

  it('stops when the card disappears, keeps what is verified, and resumes on re-run', { timeout: 120_000 }, async () => {
    const journal = await Journal.load(journalFile)
    // the card "disappears" while C0003 is being read: its folder is moved away, so the source no longer stats
    const openRead = (p: string): NodeJS.ReadableStream => {
      if (p.endsWith('C0003.MP4')) {
        renameSync(cardRoot, `${cardRoot}.off`)
        throw enoent()
      }
      return createReadStream(p)
    }
    const first = await run({ journal, openRead })
    renameSync(`${cardRoot}.off`, cardRoot)

    expect(first.summary.status).toBe('card_removed')
    expect(first.events.some((e) => e.type === 'card_removed')).toBe(true)
    expect(first.events.at(-1)).toMatchObject({ type: 'done' })
    const afterFirst = await listFiles(eventDir)
    expect(media(afterFirst)).toEqual(['Zápas/C0001_TOP_gol.MP4'])
    expect(afterFirst.some((f) => f.includes('.partial'))).toBe(false)
    expect(await sha256File(path.join(eventDir, 'Zápas/C0001_TOP_gol.MP4'))).toBe(await sha256File(clips.c1))
    const rows = await readCsv(first.summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[2]).toBe('(nekopírováno)')
    expect(rows.find((r) => r[0] === 'C0002.MP4')?.[3]).toContain('černá značka')

    const second = await run({ journal })
    expect(second.summary.status).toBe('ok')
    expect(second.summary.alreadyUploaded).toBe(1)
    expect(media(await listFiles(eventDir))).toEqual([
      'Zápas/C0001_TOP_gol.MP4',
      'Zápas/C0003_sance.MP4',
      '_ostatni/DCIM/100MSDCF/DSC00001.JPG',
      `_ostatni/${CLIP_DIR}/C0001M01.XML`,
    ])
  })

  it('treats a file whose size changed since the scan (another card in the slot) as card removal', { timeout: 120_000 }, async () => {
    const events: RunEvent[] = []
    const summary = await runCard(await baseOptions(), (e) => {
      events.push(e)
      // after the first copy, a different card with a same-named but different C0003 is inserted
      if (e.type === 'copied' && events.filter((x) => x.type === 'copied').length === 1) {
        writeFileSync(path.join(cardRoot, CLIP_DIR, 'C0003.MP4'), 'another card')
      }
    })
    expect(summary.status).toBe('card_removed')
    expect(events.some((e) => e.type === 'card_removed')).toBe(true)
    expect(media(await listFiles(eventDir))).toEqual(['Zápas/C0001_TOP_gol.MP4'])
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[2]).toBe('(nekopírováno)')
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[3]).toContain('karta byla odpojena')
  })

  it('treats a file that vanished since the scan as card removal', { timeout: 120_000 }, async () => {
    const events: RunEvent[] = []
    const summary = await runCard(await baseOptions(), (e) => {
      events.push(e)
      if (e.type === 'copied') rmSync(path.join(cardRoot, CLIP_DIR, 'C0003.MP4'), { force: true })
    })
    expect(summary.status).toBe('card_removed')
    expect(media(await listFiles(eventDir))).toEqual(['Zápas/C0001_TOP_gol.MP4'])
  })

  it('treats a vanished card at the first read (before probing) as card removal too', { timeout: 120_000 }, async () => {
    const { summary, events } = await run({ cardRoot: path.join(root, 'GONE') })
    expect(summary.status).toBe('card_removed')
    expect(events.some((e) => e.type === 'card_removed')).toBe(true)
    expect(await readCsv(summary.csvPath)).toHaveLength(1)
  })

  it('keeps an existing different file and adds the new one with the camera tag', { timeout: 120_000 }, async () => {
    await fs.mkdir(path.join(eventDir, 'Zápas'), { recursive: true })
    const existing = path.join(eventDir, 'Zápas/C0001_TOP_gol.MP4')
    await fs.writeFile(existing, 'someone else')
    const { summary } = await run()

    expect(await fs.readFile(existing, 'utf8')).toBe('someone else')
    expect(media(await listFiles(eventDir))).toContain('Zápas/C0001-SONY_TOP_gol.MP4')
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0001.MP4')?.[1]).toBe('C0001-SONY_TOP_gol.MP4')
  })

  it('reports a failed verification, continues with the other files and ends with verify_failed', { timeout: 120_000 }, async () => {
    const hashFile = async (p: string): Promise<string> => (p.includes('C0003') ? 'bad-hash' : sha256File(p))
    const { summary } = await run({ hashFile })

    expect(summary.status).toBe('verify_failed')
    expect(summary.verifyFailed).toEqual([`${CLIP_DIR}/C0003.MP4`])
    const files = media(await listFiles(eventDir))
    expect(files).toContain('Zápas/C0001_TOP_gol.MP4')
    expect(files).toContain(`_ostatni/${CLIP_DIR}/C0001M01.XML`)
    expect(files.some((f) => f.endsWith('.partial'))).toBe(true) // the failed temp is kept for inspection
    expect(files).not.toContain('Zápas/C0003_sance.MP4')
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[3]).toContain('ověření')
  })

  it('reports an unexpected per-file error and carries on', { timeout: 120_000 }, async () => {
    const openRead = (p: string): NodeJS.ReadableStream => {
      if (p.endsWith('DSC00001.JPG')) throw Object.assign(new Error('boom'), { code: 'EACCES' })
      return createReadStream(p)
    }
    const { summary } = await run({ openRead })
    expect(summary.status).toBe('verify_failed')
    expect(summary.verifyFailed).toHaveLength(1)
    expect(summary.verifyFailed[0]).toContain('DSC00001.JPG')
    expect(summary.verifyFailed[0]).toContain('boom')
    expect(media(await listFiles(eventDir))).toContain('Zápas/C0003_sance.MP4')
  })

  it('stops between files when aborted and still writes the CSV', { timeout: 120_000 }, async () => {
    const controller = new AbortController()
    const events: RunEvent[] = []
    const summary = await runCard(
      await baseOptions(),
      (e) => {
        events.push(e)
        if (e.type === 'copied') controller.abort()
      },
      controller.signal,
    )
    await expectNoAnalysisFailure(summary)
    expect(media(await listFiles(eventDir))).toEqual(['Zápas/C0001_TOP_gol.MP4'])
    expect(summary.status).toBe('aborted')
    const rows = await readCsv(summary.csvPath)
    expect(rows).toHaveLength(6)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[2]).toBe('(nekopírováno)')
  })

  it('copies Sony proxies and thumbnails to _ostatni without probing, classifying or using them for TOP', { timeout: 120_000 }, async () => {
    // proxies are real clips here (same picture and time as the originals): they would be markers/TOP candidates if analysed
    await put('PRIVATE/M4ROOT/SUB/C0001S03.MP4', { copyFrom: clips.c1 })
    await put('PRIVATE/M4ROOT/SUB/C0002S03.MP4', { copyFrom: clips.c2 })
    await put('PRIVATE/M4ROOT/THMBNL/C0001T01.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const classifier = fakeClassifier()
    const { summary, events } = await run({ classifier })

    expect([...classifier.seen].sort()).toEqual(['C0001.MP4', 'C0003.MP4'])
    expect(events[0]).toMatchObject({ type: 'scanned', videos: 3, others: 5 })
    expect(media(await listFiles(eventDir))).toEqual([
      'Zápas/C0001_TOP_gol.MP4',
      'Zápas/C0003_sance.MP4',
      '_ostatni/DCIM/100MSDCF/DSC00001.JPG',
      `_ostatni/${CLIP_DIR}/C0001M01.XML`,
      '_ostatni/PRIVATE/M4ROOT/SUB/C0001S03.MP4',
      '_ostatni/PRIVATE/M4ROOT/SUB/C0002S03.MP4',
      '_ostatni/PRIVATE/M4ROOT/THMBNL/C0001T01.JPG',
    ])
    expect(summary).toMatchObject({ top: 1, markers: 1, orphanMarkers: 0, others: 5, status: 'ok' })
  })

  it('lists an orphan marker without a TOP clip', { timeout: 120_000 }, async () => {
    await fs.rm(path.join(cardRoot, CLIP_DIR, 'C0001.MP4'))
    const { summary } = await run()
    expect(summary).toMatchObject({ top: 0, markers: 1, orphanMarkers: 1 })
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0002.MP4')?.[3]).toContain('černá značka (bez TOP)')
  })
  it('treats ENOENT/EIO on the destination as a failed file, not as card removal', { timeout: 120_000 }, async () => {
    const linkFn = async (from: string, to: string): Promise<void> => {
      if (to.includes('C0003')) throw Object.assign(new Error('EIO: destination'), { code: 'EIO' })
      await fs.link(from, to)
    }
    const { summary, events } = await run({ linkFn })
    expect(events.some((e) => e.type === 'card_removed')).toBe(false)
    expect(summary.status).toBe('verify_failed')
    expect(summary.verifyFailed).toHaveLength(1)
    expect(summary.verifyFailed[0]).toContain('C0003.MP4')
    const files = media(await listFiles(eventDir))
    expect(files).toContain('Zápas/C0001_TOP_gol.MP4')
    expect(files).toContain('_ostatni/DCIM/100MSDCF/DSC00001.JPG') // the run went on after the failure
  })

  it('stops with verify_failed when the event folder disappears, and still emits done', { timeout: 120_000 }, async () => {
    let links = 0
    const linkFn = async (): Promise<void> => {
      links++
      rmSync(eventDir, { recursive: true, force: true })
      throw Object.assign(new Error('ENOENT: destination gone'), { code: 'ENOENT' })
    }
    const { summary, events } = await run({ linkFn })
    expect(links).toBe(1)
    expect(summary.status).toBe('verify_failed')
    expect(summary.csvPath).toBe('')
    expect(summary.verifyFailed.some((v) => v.includes('C0001.MP4'))).toBe(true)
    expect(summary.verifyFailed.some((v) => v.includes('C0003.MP4'))).toBe(true) // not processed
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(events.some((e) => e.type === 'card_removed')).toBe(false)
  })

  it('never recreates the event folder: removed before the first copy, nothing is written and the run ends verify_failed', { timeout: 120_000 }, async () => {
    const inner = fakeClassifier()
    const classifier: Classifier = {
      async classify(input) {
        rmSync(eventDir, { recursive: true, force: true }) // e.g. the Drive mount vanished during classification
        return inner.classify(input)
      },
    }
    const { summary, events } = await run({ classifier })
    await expect(fs.lstat(eventDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(path.dirname(eventDir))).length).toBe(0)
    expect(summary.status).toBe('verify_failed')
    expect(summary.csvPath).toBe('')
    expect(summary.verifyFailed.some((v) => v.includes('C0001.MP4'))).toBe(true)
    expect(events.some((e) => e.type === 'copied')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('does not create the event folder when it is missing from the start', { timeout: 120_000 }, async () => {
    await fs.rm(eventDir, { recursive: true })
    const { summary } = await run()
    await expect(fs.lstat(eventDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(summary.status).toBe('verify_failed')
  })

  it('does not skip a clip from a second card that shares relPath and size with an uploaded one', { timeout: 120_000 }, async () => {
    const journal = await Journal.load(journalFile)
    await run({ journal })
    const cardB = path.join(root, 'SONY2')
    await put(`${CLIP_DIR}/C0001.MP4`, { copyFrom: clips.c1b }, cardB)
    await put(`${CLIP_DIR}/C0002.MP4`, { copyFrom: clips.c2 }, cardB)
    expect((await fs.stat(path.join(cardB, CLIP_DIR, 'C0001.MP4'))).size).toBe((await fs.stat(clips.c1)).size)
    expect(await sha256File(clips.c1b)).not.toBe(await sha256File(clips.c1))

    const classifier = fakeClassifier()
    const { summary } = await run({ journal, cardRoot: cardB, classifier })
    expect(classifier.seen).toEqual(['C0001.MP4'])
    expect(summary.alreadyUploaded).toBe(0)
    expect(summary.status).toBe('ok')
    expect(media(await listFiles(eventDir))).toContain('Zápas/C0001-SONY2_TOP_gol.MP4')
    expect(await sha256File(path.join(eventDir, 'Zápas/C0001_TOP_gol.MP4'))).toBe(await sha256File(clips.c1))
    expect(await sha256File(path.join(eventDir, 'Zápas/C0001-SONY2_TOP_gol.MP4'))).toBe(await sha256File(clips.c1b))
  })

  it('copies a file again when the journal knows it but the copy is gone from the drive', { timeout: 120_000 }, async () => {
    const journal = await Journal.load(journalFile)
    await run({ journal })
    await fs.rm(path.join(eventDir, 'Zápas/C0003_sance.MP4'))
    const classifier = fakeClassifier()
    const { summary } = await run({ journal, classifier })
    expect(classifier.seen).toEqual(['C0003.MP4'])
    expect(summary.alreadyUploaded).toBe(3)
    expect(summary.status).toBe('ok')
    expect(media(await listFiles(eventDir))).toContain('Zápas/C0003_sance.MP4')
  })
})
