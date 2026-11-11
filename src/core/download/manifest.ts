import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { errCode } from './download-steps'
import type { DownloadSummary, EntryOutcome, EntryResult } from './downloader'

/**
 * Writes the file list of a run as a CSV into the destination root. Add-only: the file is created exclusively
 * (`wx`, which also fails on an existing symlink) and never replaces anything; a taken name gets `_2`, `_3`, ...
 */

const BOM = '﻿'
const EOL = '\r\n'
const HEADER = ['cesta_na_disku', 'cesta_na_google_disku', 'velikost_B', 'md5', 'stav', 'duvod']
const FORMULA_START = /^[=+\-@\t\r]/
const MAX_NAME_TRIES = 1000

const OUTCOME_LABEL: Record<EntryOutcome, string> = {
  downloaded: 'staženo a ověřeno',
  exported: 'exportováno',
  already: 'už staženo',
  changed_copy: 'změněno na Disku (nová kopie)',
  duplicate: 'duplikát (nestaženo)',
  skipped: 'přeskočeno',
  failed: 'selhalo',
}

const STATUS_REASON: Record<Exclude<DownloadSummary['status'], 'complete'>, string> = {
  incomplete: 'některé soubory selhaly',
  destination_lost: 'disk se odpojil',
  auth_lost: 'přihlášení vypršelo',
  aborted: 'zastaveno',
  journal_error: 'poškozený záznam o stahování',
  disk_full: 'na disku došlo místo',
}

function cell(value: string): string {
  // A spreadsheet would run a cell that starts with = + - @ as a formula: mark it as text.
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const line = (fields: string[]): string => fields.map(cell).join(';')

/** `rootName/a/b.mp4` -> `a/b.mp4`: the CSV lives inside the destination root. */
const insideRoot = (localRelPath: string): string => {
  const slash = localRelPath.indexOf('/')
  return slash === -1 ? localRelPath : localRelPath.slice(slash + 1)
}

/** Size of what is on disk for files that exist there; the planned size (empty if unknown) for the rest. */
function sizeOf(r: EntryResult): string {
  if (r.outcome === 'skipped' || r.outcome === 'failed' || r.outcome === 'duplicate') return r.entry.size === null ? '' : String(r.entry.size)
  return String(r.bytes)
}

const row = (r: EntryResult): string[] => [
  insideRoot(r.localRelPath),
  r.entry.drivePath,
  sizeOf(r),
  r.md5 ?? '',
  OUTCOME_LABEL[r.outcome],
  r.reason ?? '',
]

const two = (n: number): string => String(n).padStart(2, '0')

function stamp(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}`
}

const ON_DISK: ReadonlySet<EntryOutcome> = new Set(['downloaded', 'exported', 'already', 'changed_copy'])

export async function writeManifest(destRoot: string, summary: DownloadSummary, now: Date = new Date()): Promise<string> {
  // The client-facing total: every file that is on the disk now, including ones downloaded in earlier runs.
  const onDiskBytes = summary.results.reduce((sum, r) => (ON_DISK.has(r.outcome) ? sum + r.bytes : sum), 0)
  const totals = [
    'CELKEM',
    '',
    String(onDiskBytes),
    '',
    summary.status === 'complete' ? 'kompletní' : 'NEKOMPLETNÍ',
    summary.status === 'complete' ? '' : STATUS_REASON[summary.status],
  ]
  const text = BOM + [HEADER, ...summary.results.map(row), totals].map(line).join(EOL) + EOL

  const base = `_seznam_souboru_${stamp(now)}`
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const file = path.join(destRoot, n === 1 ? `${base}.csv` : `${base}_${n}.csv`)
    let handle: fs.FileHandle
    try {
      handle = await fs.open(file, 'wx')
    } catch (e) {
      if (errCode(e) === 'EEXIST') continue
      throw e
    }
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return file
  }
  throw new Error(`no free manifest name in ${destRoot}`)
}
