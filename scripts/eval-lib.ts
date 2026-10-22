import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Classifier, ClassifyResult } from '../src/core/classifier'
import { costUsd, isKnownModel } from '../src/core/pricing'
import type { ClipMeta } from '../src/core/probe'
import { UNCLASSIFIED, type Template } from '../src/core/templates'

/* ---------- reference sets ---------- */

export type EvalSet = {
  id: string
  /** Ground-truth CSV: `puvodni_nazev;novy_nazev;slozka;poznamka`. */
  csvPath: string
  /** Env variable with the folder that holds the clips with their ORIGINAL names (searched recursively). */
  cardDirEnv: string
  cardDirDefault: string
  templateId: string
}

// TODO(davis-cup): add a `davis-cup` set. Its CSV is
// /Users/kolda/Desktop/Střih videí/drive_centralni_vyber_trideni.csv (extra columns file_id;odkaz) and the clips
// live on Google Drive, not on disk, so it needs a download/streaming step first. Not implemented.
export const EVAL_SETS: Readonly<Record<string, EvalSet>> = {
  istanbul: {
    id: 'istanbul',
    csvPath: '/Users/kolda/Desktop/Istanbul/_trideni_mapovani.csv',
    cardDirEnv: 'TRIDENI_ISTANBUL_DIR',
    cardDirDefault: '/Volumes/Untitled/PRIVATE/M4ROOT/CLIP',
    templateId: 'fotbal',
  },
}

export type ReferenceRow = { original: string; newName: string; folder: string; note: string }

const ROOT_FOLDER = '(kořen)'
const HEADER_FIELDS = ['puvodni_nazev', 'novy_nazev', 'slozka', 'poznamka'] as const

/** Minimal `;`-separated parser with `"` quoting (RFC 4180 style). */
function parseDelimited(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ';') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export function parseReferenceCsv(text: string): ReferenceRow[] {
  const table = parseDelimited(text.replace(/^﻿/, ''))
  const header = (table[0] ?? []).map((h) => h.trim())
  const col = Object.fromEntries(HEADER_FIELDS.map((f) => [f, header.indexOf(f)])) as Record<(typeof HEADER_FIELDS)[number], number>
  if (HEADER_FIELDS.some((f) => col[f] < 0)) {
    throw new Error(`Reference CSV must have header ${HEADER_FIELDS.join(';')}`)
  }
  return table.slice(1).map((r) => ({
    original: (r[col.puvodni_nazev] ?? '').trim(),
    newName: (r[col.novy_nazev] ?? '').trim(),
    folder: (r[col.slozka] ?? '').trim(),
    note: (r[col.poznamka] ?? '').trim(),
  }))
}

export type EvalClip = { original: string; expected: string; absPath: string }

export type MatchResult = {
  clips: EvalClip[]
  skippedRoot: number
  unknownFolder: ReferenceRow[]
  missing: ReferenceRow[]
  ambiguous: ReferenceRow[]
}

/** `index` maps lower-cased basename to the absolute paths found on the card. */
export function matchReference(rows: ReferenceRow[], index: ReadonlyMap<string, string[]>, template: Template): MatchResult {
  const categories = new Map(template.categories.map((c) => [c.name.normalize('NFC'), c.name]))
  const out: MatchResult = { clips: [], skippedRoot: 0, unknownFolder: [], missing: [], ambiguous: [] }
  for (const row of rows) {
    if (row.folder.normalize('NFC') === ROOT_FOLDER) {
      out.skippedRoot++
      continue
    }
    const expected = categories.get(row.folder.normalize('NFC'))
    if (!expected) {
      out.unknownFolder.push(row)
      continue
    }
    const found = index.get(row.original.toLowerCase()) ?? []
    if (found.length === 0) out.missing.push(row)
    else if (found.length > 1) out.ambiguous.push(row)
    else out.clips.push({ original: row.original, expected, absPath: found[0] as string })
  }
  return out
}

/** Read-only recursive listing; rejects when `dir` is missing (card not mounted). */
export async function indexFilesByBasename(dir: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>()
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile() && !entry.name.startsWith('.')) {
        const key = entry.name.toLowerCase()
        const list = index.get(key)
        if (list) list.push(abs)
        else index.set(key, [abs])
      }
    }
  }
  await walk(dir)
  return index
}

/* ---------- running ---------- */

export type EvalRow = {
  original: string
  expected: string
  predicted: string
  description: string
  confidence: string
  /** Predicted category equals the expected one. */
  ok: boolean
  /** Classification itself succeeded (no API / probe error). */
  apiOk: boolean
  usd: number
  error?: string
}

export type PreparedClip = { meta: ClipMeta; sheetJpeg: Buffer }

export async function runEval(opts: {
  clips: EvalClip[]
  classifier: Classifier
  template: Template
  prepare: (absPath: string) => Promise<PreparedClip>
  concurrency?: number
  onProgress?: (done: number, total: number, row: EvalRow) => void
}): Promise<EvalRow[]> {
  const { clips, classifier, template, prepare } = opts
  const rows: EvalRow[] = new Array<EvalRow>(clips.length)
  let next = 0
  let done = 0

  const one = async (clip: EvalClip): Promise<EvalRow> => {
    const base = { original: clip.original, expected: clip.expected }
    let result: ClassifyResult
    try {
      const { meta, sheetJpeg } = await prepare(clip.absPath)
      result = await classifier.classify({ sheetJpeg, meta, fileName: clip.original, template, roster: [] })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { ...base, predicted: UNCLASSIFIED, description: '', confidence: 'low', ok: false, apiOk: false, usd: 0, error }
    }
    const row: EvalRow = {
      ...base,
      predicted: result.category,
      description: result.description,
      confidence: result.confidence,
      ok: result.ok && result.category.normalize('NFC') === clip.expected.normalize('NFC'),
      apiOk: result.ok,
      usd: result.usage ? costUsd(result.usage) : 0,
    }
    if (result.error !== undefined) row.error = result.error
    return row
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      const clip = clips[i]
      if (!clip) return
      const row = await one(clip)
      rows[i] = row
      opts.onProgress?.(++done, clips.length, row)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, clips.length)) }, worker))
  return rows
}

/* ---------- statistics ---------- */

export type Confusion = {
  total: number
  correct: number
  accuracy: number
  apiFailures: number
  categories: string[]
  /** matrix[expected][predicted] */
  matrix: Record<string, Record<string, number>>
  perCategory: Record<string, { n: number; correct: number; accuracy: number | null }>
}

export function buildConfusion(rows: EvalRow[], categories: string[]): Confusion {
  const columns = [...categories, UNCLASSIFIED]
  const matrix: Confusion['matrix'] = {}
  const perCategory: Confusion['perCategory'] = {}
  for (const c of categories) {
    matrix[c] = Object.fromEntries(columns.map((p) => [p, 0]))
    perCategory[c] = { n: 0, correct: 0, accuracy: null }
  }
  let correct = 0
  for (const r of rows) {
    const line = matrix[r.expected]
    const stat = perCategory[r.expected]
    if (!line || !stat) continue
    line[r.predicted] = (line[r.predicted] ?? 0) + 1
    stat.n++
    if (r.ok) {
      stat.correct++
      correct++
    }
  }
  for (const stat of Object.values(perCategory)) stat.accuracy = stat.n === 0 ? null : stat.correct / stat.n
  return {
    total: rows.length,
    correct,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    apiFailures: rows.filter((r) => !r.apiOk).length,
    categories,
    matrix,
    perCategory,
  }
}

const pct = (x: number | null): string => (x === null ? '  -  ' : `${(x * 100).toFixed(1)} %`)

/** Rows = expected, columns = predicted (incl. `_nezařazeno`). */
export function formatConfusion(c: Confusion): string {
  const columns = [...c.categories, UNCLASSIFIED]
  const labelW = Math.max(...columns.map((x) => x.length), 'expected \\ predicted'.length)
  const colW = columns.map((x) => Math.max(x.length, 4))
  const lines = [
    ['expected \\ predicted'.padEnd(labelW), ...columns.map((x, i) => x.padStart(colW[i] ?? 0)), '  n', '  accuracy'].join(' | '),
  ]
  for (const e of c.categories) {
    const stat = c.perCategory[e]
    lines.push(
      [
        e.padEnd(labelW),
        ...columns.map((p, i) => String(c.matrix[e]?.[p] ?? 0).padStart(colW[i] ?? 0)),
        String(stat?.n ?? 0).padStart(3),
        pct(stat?.accuracy ?? null).padStart(10),
      ].join(' | '),
    )
  }
  return lines.join('\n')
}

export function aggregateCost(rows: EvalRow[], czkRate: number): { usd: number; czk: number } {
  const usd = rows.reduce((sum, r) => sum + r.usd, 0)
  return { usd, czk: usd * czkRate }
}

/** Rough per-clip token budget: one 1024x576 contact sheet + short prompt in, short JSON out. Prompt caching ignored (upper bound). */
export const ESTIMATE_PER_CLIP = { input: 1500, output: 120 }

export function estimateRun(clipCount: number, model: string, czkRate: number): { usd: number; czk: number } {
  const perClip = costUsd({ input: ESTIMATE_PER_CLIP.input, output: ESTIMATE_PER_CLIP.output, cacheRead: 0, cacheWrite: 0, model })
  const usd = perClip * clipCount
  return { usd, czk: usd * czkRate }
}

/* ---------- output ---------- */

const RESULT_HEADER = ['original', 'expected', 'predicted', 'description', 'confidence', 'ok', 'usd', 'error']

function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Own output under `eval-results/` (gitignored); overwritten on re-run. */
export async function writeResultsCsv(file: string, rows: EvalRow[]): Promise<void> {
  const lines = [
    RESULT_HEADER,
    ...rows.map((r) => [r.original, r.expected, r.predicted, r.description, r.confidence, r.ok ? 'yes' : 'no', r.usd.toFixed(6), r.error ?? '']),
  ].map((fields) => fields.map(cell).join(';'))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '﻿' + lines.join('\r\n') + '\r\n', 'utf8')
}

export function formatSummary(opts: { set: string; model: string; rows: EvalRow[]; categories: string[]; czkRate: number }): string {
  const c = buildConfusion(opts.rows, opts.categories)
  const cost = aggregateCost(opts.rows, opts.czkRate)
  return [
    `Set: ${opts.set}   model: ${opts.model}`,
    `Accuracy: ${c.correct}/${c.total} = ${pct(c.accuracy)}` + (c.apiFailures > 0 ? `   (failed classifications: ${c.apiFailures}, counted as wrong)` : ''),
    '',
    formatConfusion(c),
    '',
    `Cost: ${cost.usd.toFixed(4)} USD = ${cost.czk.toFixed(2)} CZK (rate ${opts.czkRate})`,
  ].join('\n')
}

/* ---------- CLI ---------- */

export class EvalUsageError extends Error {}

export type EvalArgs = { set: string; model: string; limit?: number; czk: number; yes: boolean; help: boolean }

export const DEFAULT_MODEL = 'claude-sonnet-5-5'
export const DEFAULT_CZK = 23

export const USAGE = `Usage: npm run eval -- --set <${Object.keys(EVAL_SETS).join('|')}> [--model ${DEFAULT_MODEL}] [--limit N] [--czk ${DEFAULT_CZK}] [--yes]

  --set    reference set (only: ${Object.keys(EVAL_SETS).join(', ')})
  --model  claude-sonnet-5-5 (default) | claude-opus-5-5 | claude-haiku-5-5
  --limit  classify only the first N matched clips (CSV order)
  --czk    CZK per USD for the cost summary (default ${DEFAULT_CZK})
  --yes    really call the API (without it only the cost estimate is printed)

Needs ANTHROPIC_API_KEY in the environment. Camera card folder: env TRIDENI_ISTANBUL_DIR.`

export function parseEvalArgs(argv: string[]): EvalArgs {
  let values: { set?: string; model?: string; limit?: string; czk?: string; yes?: boolean; help?: boolean }
  try {
    values = parseArgs({
      args: argv,
      options: {
        set: { type: 'string' },
        model: { type: 'string' },
        limit: { type: 'string' },
        czk: { type: 'string' },
        yes: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (err) {
    throw new EvalUsageError(err instanceof Error ? err.message : String(err))
  }

  const help = values.help === true
  if (help) return { set: values.set ?? '', model: values.model ?? DEFAULT_MODEL, czk: DEFAULT_CZK, yes: false, help }

  const sets = Object.keys(EVAL_SETS)
  if (!values.set || !sets.includes(values.set)) {
    throw new EvalUsageError(`--set is required and must be one of: ${sets.join(', ')}`)
  }
  const model = values.model ?? DEFAULT_MODEL
  if (!isKnownModel(model)) throw new EvalUsageError(`Unknown model "${model}"`)

  const out: EvalArgs = { set: values.set, model, czk: DEFAULT_CZK, yes: values.yes === true, help }
  if (values.limit !== undefined) {
    const n = Number(values.limit)
    if (!Number.isInteger(n) || n < 1) throw new EvalUsageError('--limit must be a positive integer')
    out.limit = n
  }
  if (values.czk !== undefined) {
    const r = Number(values.czk)
    if (!Number.isFinite(r) || r <= 0) throw new EvalUsageError('--czk must be a positive number')
    out.czk = r
  }
  return out
}
