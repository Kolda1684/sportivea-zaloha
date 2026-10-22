import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { scanCard } from './card'
import type { Classifier, ClassifyResult } from './classifier'
import { writeMappingCsv, type MappingRow } from './csv'
import { copyVerified, sha256File, type CopyOptions, type CopyOutcome } from './copy'
import { makeSpaceWaiter } from './diskspace'
import { contactSheet, frameLumas } from './frames'
import type { Journal, JournalEntry } from './journal'
import { detectMarkers, type MarkerInput } from './markers'
import { buildName, parseOriginalName, slugify, withConflictSuffix } from './naming'
import { costUsd } from './pricing'
import { probeClip, type ClipMeta } from './probe'
import type { RosterEntry } from './roster'
import { OTHER_FILES, UNCLASSIFIED, type Template } from './templates'
import type { CardFile } from './types'

export type RunOptions = {
  cardRoot: string
  eventDir: string
  template: Template
  roster: RosterEntry[]
  classifier: Classifier
  journal: Journal
  /** Parallel classifications (and API calls). Default 4. */
  concurrency?: number
  markerOpts?: Parameters<typeof detectMarkers>[1]
  /**
   * Awaited with the source size before each copy. Default: waits for the event volume to have the
   * file plus a 5 GiB reserve and emits `waiting_space`. A custom function owns its own notifications.
   */
  waitForSpace?: (bytes: number) => Promise<void>
  /** Opens a SOURCE file for reading (default `fs.createReadStream`); injectable to simulate a failing card. */
  openRead?: CopyOptions['openRead']
  /** Hashes the copied temp file for verification (default streaming SHA-256). */
  hashFile?: CopyOptions['hashFile']
  /** Hard-link primitive used by the copy step (default `fs.link`); injectable for tests. */
  linkFn?: CopyOptions['linkFn']
}

export type RunEvent =
  | { type: 'scanned'; videos: number; others: number; bytes: number }
  | { type: 'classified'; relPath: string; result: ClassifyResult; top: boolean; marker: boolean }
  | { type: 'copied'; relPath: string; outcome: CopyOutcome }
  | { type: 'waiting_space'; needed: number; free: number }
  | { type: 'card_removed' }
  | { type: 'done'; summary: RunSummary }

export type RunSummary = {
  perFolder: Record<string, number>
  top: number
  markers: number
  orphanMarkers: number
  unclassified: number
  lowConfidence: string[]
  alreadyUploaded: number
  verifyFailed: string[]
  others: number
  costUsd: number
  csvPath: string
  status: 'ok' | 'card_removed' | 'verify_failed' | 'aborted'
}

const DEFAULT_CONCURRENCY = 4
/** Probing and frame sampling read the card heavily (frameLumas already runs 3 ffmpeg at once). */
const ANALYSIS_CONCURRENCY = 2
const NOT_COPIED = '(nekopírováno)'
const SOURCE_GONE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EIO', 'ENXIO'])

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const code = (e as { code?: unknown }).code
  if (typeof code === 'string') return code
  return errCode((e as { cause?: unknown }).cause)
}

/** A source read that fails like this means the card is gone (unplugged, ejected, I/O error). */
function isCardGone(e: unknown): boolean {
  const code = errCode(e)
  return code !== undefined && SOURCE_GONE_CODES.has(code)
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Strips the error code so that a failure on the DESTINATION side is never mistaken for card removal. */
function asDestinationError(what: string, e: unknown): Error {
  return new Error(`${what}: ${errMessage(e)}`)
}

function isPlainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name) && path.basename(name) === name
}

function tagFrom(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function csvName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `_trideni_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}.csv`
}

/** Runs `fn` for every item with at most `limit` in flight; stops taking new items when `stop()` is true. `fn` must not throw. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, stop: () => boolean): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (!stop()) {
      const item = items[next++]
      if (item === undefined) return
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

type Clip = {
  file: CardFile
  fileName: string
  base: string
  handLabel?: string
  ext: string
  meta?: ClipMeta
  lumas?: number[]
  /** Set when probing/sampling failed for a reason other than card removal. */
  analysisError?: string
}

type Planned = {
  file: CardFile
  clip?: Clip
  result?: ClassifyResult
  top: boolean
}

function failure(error: string): ClassifyResult {
  return { category: UNCLASSIFIED, description: '', confidence: 'low', ok: false, error }
}

function compareByDate(a: Planned, b: Planned): number {
  const ad = a.clip?.meta?.createdAt ?? null
  const bd = b.clip?.meta?.createdAt ?? null
  if (ad !== null && bd !== null) {
    const d = ad.getTime() - bd.getTime()
    if (d !== 0) return d
  } else if (ad !== null) {
    return -1
  } else if (bd !== null) {
    return 1
  }
  return a.file.relPath < b.file.relPath ? -1 : a.file.relPath > b.file.relPath ? 1 : 0
}

/** Creates `segments` one level at a time beneath `base`, which must already exist (it is never created, unlike `mkdir -p`). */
async function mkdirBelow(base: string, segments: readonly string[]): Promise<void> {
  let dir = base
  for (const segment of segments) {
    dir = path.join(dir, segment)
    try {
      await fs.mkdir(dir)
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e
    }
  }
}

const byRelPath = (a: CardFile, b: CardFile): number => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)

/**
 * Card -> sorted, verified copy in `eventDir`.
 * scan -> probe + sample all videos -> black markers / TOP -> classify (parallel) -> copy sequentially
 * (TOP first, then by recording time, then other files) -> mapping CSV.
 * The card is only ever read. Nothing at the destination is overwritten, moved or deleted.
 */
export async function runCard(opts: RunOptions, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<RunSummary> {
  const emit = (e: RunEvent): void => {
    try {
      onEvent(e)
    } catch {
      // a faulty listener must never interrupt the backup
    }
  }
  const { cardRoot, eventDir, template, roster, classifier, journal } = opts
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY))
  const volumeName = path.basename(cardRoot) || 'karta'
  const volumeTag = tagFrom(slugify(volumeName)) || 'CARD'
  const waitForSpace = opts.waitForSpace ?? makeSpaceWaiter(eventDir, { onWaiting: (needed, free) => emit({ type: 'waiting_space', needed, free }) })
  const hashFile = opts.hashFile ?? sha256File

  let cardRemoved = false
  let destinationGone = false
  const markCardRemoved = (): void => {
    if (cardRemoved) return
    cardRemoved = true
    emit({ type: 'card_removed' })
  }
  const stopped = (): boolean => cardRemoved || destinationGone || signal?.aborted === true

  const rows = new Map<string, MappingRow>()
  const perFolder: Record<string, number> = {}
  const lowConfidence: string[] = []
  const verifyFailed: string[] = []
  const placed = new Set<string>()
  let alreadyUploaded = 0
  let unclassified = 0
  let others = 0
  let cost = 0
  let topCount = 0
  let markerCount = 0
  let orphanCount = 0

  // ---- scan
  let files: CardFile[] = []
  try {
    files = await scanCard(cardRoot)
    emit({
      type: 'scanned',
      videos: files.filter((f) => f.kind === 'video').length,
      others: files.filter((f) => f.kind === 'other').length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
    })
  } catch (e) {
    if (!isCardGone(e)) throw e
    markCardRemoved()
  }

  const nameCount = new Map<string, number>()
  for (const f of files) {
    const n = path.posix.basename(f.relPath)
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1)
  }
  /** File name, or the card path when several files share the name. */
  const shownName = (f: CardFile): string => ((nameCount.get(path.posix.basename(f.relPath)) ?? 0) > 1 ? f.relPath : path.posix.basename(f.relPath))
  const setRow = (f: CardFile, newName: string, folder: string, notes: string[]): void => {
    rows.set(f.relPath, { original: shownName(f), newName, folder, note: notes.join('; ') })
  }

  // ---- probe + sample every video (markers need all of them)
  const clips = new Map<string, Clip>()
  const videos = files.filter((f) => f.kind === 'video')
  for (const file of videos) {
    const fileName = path.posix.basename(file.relPath)
    const parsed = parseOriginalName(fileName)
    const clip: Clip = { file, fileName, base: parsed.base, ext: parsed.ext }
    if (parsed.handLabel !== undefined) clip.handLabel = parsed.handLabel
    clips.set(file.relPath, clip)
  }

  await pool(
    videos,
    ANALYSIS_CONCURRENCY,
    async (file) => {
      const clip = clips.get(file.relPath)
      if (!clip) return
      try {
        clip.meta = await probeClip(file.absPath)
        clip.lumas = await frameLumas(file.absPath, clip.meta.durationS)
      } catch (e) {
        if (isCardGone(e)) return markCardRemoved()
        try {
          await fs.stat(file.absPath) // ffmpeg errors carry no errno: check whether the source is still there
        } catch (statErr) {
          if (isCardGone(statErr)) return markCardRemoved()
        }
        delete clip.meta
        delete clip.lumas
        clip.analysisError = errMessage(e)
      }
    },
    stopped,
  )

  // ---- markers and TOP
  const markerSet = new Set<string>()
  const topSet = new Set<string>()
  if (!stopped()) {
    const cameraKeyOf = (c: Clip): string => c.meta?.cameraModel ?? volumeName
    const inputs: MarkerInput[] = []
    for (const clip of clips.values()) {
      if (!clip.meta || !clip.lumas) continue
      inputs.push({
        id: clip.file.relPath,
        durationS: clip.meta.durationS,
        createdAt: clip.meta.createdAt,
        cameraKey: cameraKeyOf(clip),
        lumas: clip.lumas,
      })
    }
    const detected = detectMarkers(inputs, opts.markerOpts)
    for (const id of detected.markers) markerSet.add(id)
    for (const id of detected.top) topSet.add(id)
    topCount = detected.top.size
    markerCount = detected.markers.size
    orphanCount = detected.orphanMarkers.size
    for (const id of detected.markers) {
      const clip = clips.get(id)
      if (!clip) continue
      const orphan = detected.orphanMarkers.has(id)
      setRow(clip.file, '', NOT_COPIED, [orphan ? 'černá značka (bez TOP)' : 'černá značka'])
      emit({
        type: 'classified',
        relPath: id,
        result: { category: UNCLASSIFIED, description: '', confidence: 'high', ok: true },
        top: false,
        marker: true,
      })
    }
  }

  // ---- classify non-marker videos that are not on the drive yet
  const results = new Map<string, ClassifyResult>()
  // A journal hit on (relPath, size) is only a candidate: two cards of one event share names and sizes.
  // The skip is accepted when the source content hash is known to the journal AND that file is still at the drive.
  const confirmed = new Map<string, JournalEntry>()
  const openRead = opts.openRead ?? ((p: string): NodeJS.ReadableStream => createReadStream(p))
  const hashSource = async (absPath: string): Promise<string> => {
    const hash = createHash('sha256')
    for await (const chunk of openRead(absPath)) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }
  if (!stopped()) {
    const candidates = files.filter((f) => !markerSet.has(f.relPath) && journal.findByOriginal(eventDir, f.relPath, f.size) !== undefined)
    await pool(
      candidates,
      ANALYSIS_CONCURRENCY,
      async (file) => {
        try {
          const entry = journal.find(eventDir, await hashSource(file.absPath), file.size)
          if (!entry) return
          const st = await fs.lstat(entry.destPath)
          if (st.isFile() && st.size === file.size) confirmed.set(file.relPath, entry)
        } catch {
          // Not confirmed (unreadable, or the journalled copy is gone): classify and copy normally.
          // If the source itself vanished, that is card removal.
          try {
            await fs.stat(file.absPath)
          } catch (statErr) {
            if (isCardGone(statErr)) markCardRemoved()
          }
        }
      },
      stopped,
    )
  }

  if (!stopped()) {
    const toClassify = videos.filter((f) => !markerSet.has(f.relPath) && !confirmed.has(f.relPath))
    await pool(
      toClassify,
      concurrency,
      async (file) => {
        const clip = clips.get(file.relPath)
        if (!clip) return
        let result: ClassifyResult | undefined
        if (clip.analysisError !== undefined || !clip.meta) {
          result = failure(`náhled klipu selhal: ${clip.analysisError ?? 'neznámá chyba'}`)
        } else {
          let sheet: Buffer | undefined
          try {
            sheet = await contactSheet(file.absPath, clip.meta.durationS)
          } catch (e) {
            if (isCardGone(e)) return markCardRemoved()
            result = failure(`náhled klipu selhal: ${errMessage(e)}`)
          }
          if (sheet !== undefined) {
            try {
              result = await classifier.classify({
                sheetJpeg: sheet,
                meta: clip.meta,
                fileName: clip.fileName,
                ...(clip.handLabel !== undefined ? { handLabel: clip.handLabel } : {}),
                template,
                roster,
              })
            } catch (e) {
              result = failure(errMessage(e))
            }
          }
        }
        result ??= failure('náhled klipu selhal')
        results.set(file.relPath, result)
        emit({ type: 'classified', relPath: file.relPath, result, top: topSet.has(file.relPath), marker: false })
      },
      stopped,
    )
    for (const [relPath, result] of results) {
      if (result.usage) {
        try {
          cost += costUsd(result.usage)
        } catch {
          // unknown model: cost display only, never blocks the backup
        }
      }
      if (result.ok && result.confidence === 'low') lowConfidence.push(relPath)
    }
  }

  // ---- copy: TOP first, then the other videos by recording time, then other files
  const planVideo = (file: CardFile): Planned => {
    const clip = clips.get(file.relPath)
    const planned: Planned = { file, top: topSet.has(file.relPath) }
    if (clip) planned.clip = clip
    const result = results.get(file.relPath)
    if (result) planned.result = result
    return planned
  }
  const nonMarkerVideos = videos.filter((f) => !markerSet.has(f.relPath)).map(planVideo)
  const ordered: Planned[] = [
    ...nonMarkerVideos.filter((p) => p.top).sort(compareByDate),
    ...nonMarkerVideos.filter((p) => !p.top).sort(compareByDate),
    ...files
      .filter((f) => f.kind === 'other')
      .sort(byRelPath)
      .map((file): Planned => ({ file, top: false })),
  ]

  const journalNote = async (entry: Parameters<Journal['append']>[0]): Promise<string[]> => {
    try {
      await journal.append(entry)
      return []
    } catch (e) {
      return [`zápis do deníku selhal: ${errMessage(e)}`]
    }
  }

  const place = (p: Planned, folder: string, newName: string, notes: string[]): void => {
    setRow(p.file, newName, folder, notes)
    placed.add(p.file.relPath)
    if (p.file.kind === 'other') {
      others++
    } else {
      perFolder[folder] = (perFolder[folder] ?? 0) + 1
      if (folder === UNCLASSIFIED) unclassified++
    }
  }

  /** The event folder is created by the caller. It is never (re)created here: a vanished mount must not turn into a local folder. */
  const eventDirExists = async (): Promise<boolean> => {
    try {
      return (await fs.lstat(eventDir)).isDirectory()
    } catch {
      return false
    }
  }

  for (const p of ordered) {
    if (stopped()) break
    if (!(await eventDirExists())) {
      destinationGone = true
      break
    }
    const { file } = p
    const notes: string[] = []
    if (p.top) notes.push('TOP')

    // already uploaded in an earlier run (same event, same card path and size)
    const hit = confirmed.get(file.relPath)
    if (hit) {
      alreadyUploaded++
      const rel = path.relative(eventDir, path.dirname(hit.destPath)).split(path.sep).join('/')
      place(p, rel, path.basename(hit.destPath), [...notes, 'již nahráno dříve'])
      emit({ type: 'copied', relPath: file.relPath, outcome: { status: 'duplicate', destPath: hit.destPath, sha256: hit.sha256 } })
      continue
    }

    // folder and desired name
    let folder: string
    let desiredName: string
    let base: string
    if (file.kind === 'other') {
      const dir = path.posix.dirname(file.relPath)
      folder = dir === '.' ? OTHER_FILES : `${OTHER_FILES}/${dir}`
      desiredName = path.posix.basename(file.relPath)
      base = parseOriginalName(desiredName).base
    } else {
      const clip = p.clip
      const result = p.result ?? failure('klip nebyl klasifikován')
      const fileName = clip?.fileName ?? path.posix.basename(file.relPath)
      base = clip?.base ?? parseOriginalName(fileName).base
      folder = UNCLASSIFIED
      desiredName = fileName
      if (result.ok) {
        const candidate = buildName({ base, description: result.description, top: p.top, ext: clip?.ext ?? '' })
        if (isPlainName(result.category)) folder = result.category
        else notes.push('neplatná kategorie od klasifikátoru')
        if (isPlainName(candidate)) desiredName = candidate
        else notes.push('neplatný název od klasifikátoru, ponechán původní název')
      } else if (result.error !== undefined) {
        notes.push(`klasifikace selhala: ${result.error}`)
      } else {
        notes.push('klasifikace selhala')
      }
      if (result.ok && result.confidence === 'low') notes.push('nízká jistota')
    }

    const cameraModel = p.clip?.meta?.cameraModel
    const cameraTag = (cameraModel ? tagFrom(cameraModel) : '') || volumeTag
    const destDir = path.join(eventDir, ...folder.split('/'))

    try {
      await mkdirBelow(eventDir, folder.split('/'))
    } catch (e) {
      verifyFailed.push(`${file.relPath} (${errMessage(e)})`)
      setRow(file, '', NOT_COPIED, [...notes, `složku nešlo vytvořit: ${errMessage(e)}`])
      continue
    }

    let outcome: CopyOutcome
    try {
      const copyOpts: CopyOptions = {
        cameraTag,
        base,
        waitForSpace: async (bytes) => {
          try {
            await waitForSpace(bytes)
          } catch (e) {
            throw asDestinationError('kontrola volného místa selhala', e)
          }
        },
        hashFile: async (tempPath) => {
          try {
            return await hashFile(tempPath)
          } catch (e) {
            throw asDestinationError('ověření zkopírovaného souboru selhalo', e)
          }
        },
      }
      if (opts.openRead) copyOpts.openRead = opts.openRead
      if (opts.linkFn) copyOpts.linkFn = opts.linkFn
      outcome = await copyVerified(file.absPath, destDir, desiredName, copyOpts)
    } catch (e) {
      if (isCardGone(e)) {
        // ENOENT/EIO/ENXIO can also come from the destination: it is card removal only if the source is gone too.
        let sourceGone = false
        try {
          await fs.stat(file.absPath)
        } catch (statErr) {
          sourceGone = isCardGone(statErr)
        }
        if (sourceGone) {
          markCardRemoved()
          break
        }
      }
      verifyFailed.push(`${file.relPath} (${errMessage(e)})`)
      setRow(file, '', NOT_COPIED, [...notes, `kopírování selhalo: ${errMessage(e)}`])
      try {
        await fs.stat(eventDir)
      } catch {
        destinationGone = true // the event folder itself is gone (e.g. Drive unmounted): nothing more can be written
        break
      }
      continue
    }

    emit({ type: 'copied', relPath: file.relPath, outcome })
    if (outcome.status === 'verify_failed') {
      verifyFailed.push(file.relPath)
      setRow(file, '', '(chyba ověření)', [...notes, `ověření selhalo, dočasný soubor: ${outcome.tempPath}`])
      continue
    }

    if (outcome.status === 'duplicate') {
      alreadyUploaded++
      notes.push('stejný soubor už v cíli byl')
    } else if (path.basename(outcome.destPath) !== desiredName) {
      notes.push('název byl obsazený')
    }
    notes.push(
      ...(await journalNote({
        sha256: outcome.sha256,
        size: file.size,
        originalRelPath: file.relPath,
        eventDir,
        destPath: outcome.destPath,
        at: new Date().toISOString(),
      })),
    )
    place(p, folder, path.basename(outcome.destPath), notes)
  }

  // ---- every file on the card is accounted for
  const unplaced = files.filter((f) => !markerSet.has(f.relPath) && !placed.has(f.relPath) && !rows.get(f.relPath))
  const aborted = signal?.aborted === true
  const pendingNote = cardRemoved
    ? 'nezpracováno: karta byla odpojena'
    : destinationGone
      ? 'nezpracováno: cílová složka zmizela'
      : aborted
        ? 'nezpracováno: přerušeno'
        : 'nezpracováno'
  const csvRows: MappingRow[] = files.map(
    (f) => rows.get(f.relPath) ?? { original: shownName(f), newName: '', folder: NOT_COPIED, note: pendingNote },
  )
  // Unprocessed files are only acceptable when the run was stopped on purpose or by card removal.
  if (!cardRemoved && !aborted) {
    for (const f of unplaced) verifyFailed.push(`${f.relPath} (${pendingNote})`)
  }

  const stamp = csvName(new Date())
  let csvPath = ''
  try {
    // No mkdir here either: without the event folder the CSV simply cannot be written (and is reported as such).
    for (let n = 1; csvPath === ''; n++) {
      const candidate = path.join(eventDir, n === 1 ? stamp : withConflictSuffix(stamp, n))
      try {
        await writeMappingCsv(candidate, csvRows)
        csvPath = candidate
      } catch (e) {
        if (errCode(e) !== 'EEXIST') throw e
      }
    }
  } catch (e) {
    csvPath = ''
    verifyFailed.push(`CSV report (${errMessage(e)})`)
  }

  const summary: RunSummary = {
    perFolder,
    top: topCount,
    markers: markerCount,
    orphanMarkers: orphanCount,
    unclassified,
    lowConfidence,
    alreadyUploaded,
    verifyFailed,
    others,
    costUsd: cost,
    csvPath,
    status: cardRemoved
      ? 'card_removed'
      : aborted && unplaced.length > 0
        ? 'aborted'
        : verifyFailed.length > 0
          ? 'verify_failed'
          : 'ok',
  }
  emit({ type: 'done', summary })
  return summary
}
