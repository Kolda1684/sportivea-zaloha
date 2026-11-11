import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadSummary, EntryOutcome, EntryResult } from '../../../src/core/download/downloader'
import { writeManifest } from '../../../src/core/download/manifest'
import type { PlanEntry } from '../../../src/core/download/types'

let tmp: string
let destRoot: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'))
  destRoot = path.join(tmp, 'Sklad')
  await fs.mkdir(destRoot)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const BOM = '﻿'
const HEADER = 'cesta_na_disku;cesta_na_google_disku;velikost_B;md5;stav;duvod'
const NOW = new Date(2026, 9, 26, 14, 5, 59)

function entry(name: string, over: Partial<PlanEntry> = {}): PlanEntry {
  return {
    fileId: `id-${name}`,
    drivePath: `Sklad/Slozka/${name}`,
    localRelPath: `Sklad/Slozka/${name}`,
    kind: 'file',
    size: 10,
    md5: null,
    mimeType: 'video/mp4',
    exportMime: null,
    modifiedTime: '2026-01-01T00:00:00.000Z',
    skipReason: null,
    blocked: false,
    duplicate: false,
    ...over,
  }
}

function result(
  name: string,
  outcome: EntryOutcome,
  over: Partial<EntryResult> = {},
  entryOver: Partial<PlanEntry> = {},
): EntryResult {
  const e = entry(name, entryOver)
  return { entry: e, outcome, localRelPath: e.localRelPath, md5: null, bytes: 0, reason: null, ...over }
}

function summary(results: EntryResult[], over: Partial<DownloadSummary> = {}): DownloadSummary {
  return {
    status: 'complete',
    results,
    downloadedBytes: 0,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T12:00:00.000Z',
    ...over,
  }
}

/** Minimal RFC 4180 style parser for `;` separated text with `"` quoting and CRLF rows. */
function parse(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
    if (quoted) {
      if (c === '"' && text.charAt(i + 1) === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ';') {
      row.push(cur)
      cur = ''
    } else if (c === '\r' && text.charAt(i + 1) === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
      i++
    } else cur += c
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur)
    rows.push(row)
  }
  return rows
}

const readManifest = (file: string): Promise<string> => fs.readFile(file, 'utf8')

describe('writeManifest', () => {
  it('writes BOM, exact header and CRLF to a time-stamped file in the destination root', async () => {
    const file = await writeManifest(destRoot, summary([]), NOW)
    expect(file).toBe(path.join(destRoot, '_seznam_souboru_2026-10-26_14-05.csv'))
    const raw = await fs.readFile(file)
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    const text = raw.toString('utf8')
    expect(text.startsWith(`${BOM}${HEADER}\r\n`)).toBe(true)
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('round-trips a name with ; and " and newlines', async () => {
    const name = 'a;b "quoted"\nline.mp4'
    const r = result(name, 'downloaded', { bytes: 5, md5: 'abc' })
    const file = await writeManifest(destRoot, summary([r], { downloadedBytes: 5 }), NOW)
    const rows = parse((await readManifest(file)).slice(1))
    expect(rows[1]).toEqual([`Slozka/${name}`, `Sklad/Slozka/${name}`, '5', 'abc', 'staženo a ověřeno', ''])
  })

  it('maps every outcome to its label and a size', async () => {
    const results = [
      result('a.mp4', 'downloaded', { bytes: 11, md5: 'm1' }),
      result('b.docx', 'exported', { bytes: 22 }, { kind: 'export', size: null }),
      result('c.mp4', 'already', { bytes: 33, md5: 'm3' }),
      result('d.mp4', 'changed_copy', { bytes: 44, md5: 'm4', localRelPath: 'Sklad/Slozka/d (2).mp4' }),
      result('e.lnk', 'skipped', { reason: 'zástupce' }, { kind: 'skip', size: null }),
      result('f.mp4', 'failed', { reason: 'výpadek spojení, zkus znovu' }, { size: 77 }),
      result('g.mp4', 'duplicate', { md5: 'm1', reason: 'stejný obsah jako Sklad/Slozka/a.mp4' }, { size: 11 }),
    ]
    const file = await writeManifest(destRoot, summary(results, { status: 'incomplete', downloadedBytes: 77 }), NOW)
    const rows = parse((await readManifest(file)).slice(1))
    expect(rows.slice(1, 8)).toEqual([
      ['Slozka/a.mp4', 'Sklad/Slozka/a.mp4', '11', 'm1', 'staženo a ověřeno', ''],
      ['Slozka/b.docx', 'Sklad/Slozka/b.docx', '22', '', 'exportováno', ''],
      ['Slozka/c.mp4', 'Sklad/Slozka/c.mp4', '33', 'm3', 'už staženo', ''],
      ['Slozka/d (2).mp4', 'Sklad/Slozka/d.mp4', '44', 'm4', 'změněno na Disku (nová kopie)', ''],
      ['Slozka/e.lnk', 'Sklad/Slozka/e.lnk', '', '', 'přeskočeno', 'zástupce'],
      ['Slozka/f.mp4', 'Sklad/Slozka/f.mp4', '77', '', 'selhalo', 'výpadek spojení, zkus znovu'],
      ['Slozka/g.mp4', 'Sklad/Slozka/g.mp4', '11', 'm1', 'duplikát (nestaženo)', 'stejný obsah jako Sklad/Slozka/a.mp4'],
    ])
  })

  it('ends with a totals line: complete', async () => {
    const r = result('a.mp4', 'downloaded', { bytes: 1234 })
    const file = await writeManifest(destRoot, summary([r], { downloadedBytes: 1234 }), NOW)
    const text = await readManifest(file)
    expect(text.endsWith('\r\nCELKEM;;1234;;kompletní;\r\n')).toBe(true)
  })

  it('totals all files that are on the disk, including ones downloaded in earlier runs', async () => {
    const results = [
      result('a.mp4', 'already', { bytes: 500 }),
      result('b.mp4', 'downloaded', { bytes: 20 }),
      result('c.docx', 'exported', { bytes: 3 }),
      result('d.mp4', 'failed', { reason: 'x' }, { size: 999 }),
    ]
    const file = await writeManifest(destRoot, summary(results, { status: 'incomplete', downloadedBytes: 23 }), NOW)
    expect((await readManifest(file)).endsWith('\r\nCELKEM;;523;;NEKOMPLETNÍ;některé soubory selhaly\r\n')).toBe(true)
  })

  it.each([
    ['incomplete', 'některé soubory selhaly'],
    ['destination_lost', 'disk se odpojil'],
    ['auth_lost', 'přihlášení vypršelo'],
    ['aborted', 'zastaveno'],
    ['journal_error', 'poškozený záznam o stahování'],
    ['disk_full', 'na disku došlo místo'],
  ] as const)('totals line for %s says NEKOMPLETNÍ with a reason', async (status, reason) => {
    const file = await writeManifest(destRoot, summary([], { status, downloadedBytes: 9 }), NOW)
    const text = await readManifest(file)
    expect(text.endsWith(`\r\nCELKEM;;0;;NEKOMPLETNÍ;${reason}\r\n`)).toBe(true)
  })

  it('guards cells that start with = + - @ against spreadsheet formulas', async () => {
    const results = ['=SUM(A1).mp4', '+1.mp4', '-2.mp4', '@x.mp4'].map((n) =>
      result(n, 'downloaded', { bytes: 1, localRelPath: `Sklad/${n}` }, { drivePath: n }),
    )
    const file = await writeManifest(destRoot, summary(results), NOW)
    const rows = parse((await readManifest(file)).slice(1))
    expect(rows.slice(1, 5)).toEqual([
      ["'=SUM(A1).mp4", "'=SUM(A1).mp4", '1', '', 'staženo a ověřeno', ''],
      ["'+1.mp4", "'+1.mp4", '1', '', 'staženo a ověřeno', ''],
      ["'-2.mp4", "'-2.mp4", '1', '', 'staženo a ověřeno', ''],
      ["'@x.mp4", "'@x.mp4", '1', '', 'staženo a ověřeno', ''],
    ])
  })

  it('guards a reason that starts with a formula character', async () => {
    const r = result('f.mp4', 'failed', { reason: '=cmd' })
    const file = await writeManifest(destRoot, summary([r], { status: 'incomplete' }), NOW)
    const rows = parse((await readManifest(file)).slice(1))
    expect(rows[1]?.[5]).toBe("'=cmd")
  })

  it('never overwrites: an existing file gets _2, then _3, and stays byte-identical', async () => {
    const first = path.join(destRoot, '_seznam_souboru_2026-10-26_14-05.csv')
    await fs.writeFile(first, 'precious')
    const before = await fs.readFile(first)
    const second = await writeManifest(destRoot, summary([]), NOW)
    expect(second).toBe(path.join(destRoot, '_seznam_souboru_2026-10-26_14-05_2.csv'))
    const third = await writeManifest(destRoot, summary([]), NOW)
    expect(third).toBe(path.join(destRoot, '_seznam_souboru_2026-10-26_14-05_3.csv'))
    expect(await fs.readFile(first)).toEqual(before)
    expect((await readManifest(second)).startsWith(BOM + HEADER)).toBe(true)
  })

  it('never follows a symlink sitting at the target name', async () => {
    const victim = path.join(tmp, 'victim.txt')
    await fs.writeFile(victim, 'keep me')
    await fs.symlink(victim, path.join(destRoot, '_seznam_souboru_2026-10-26_14-05.csv'))
    const file = await writeManifest(destRoot, summary([]), NOW)
    expect(file).toBe(path.join(destRoot, '_seznam_souboru_2026-10-26_14-05_2.csv'))
    expect(await fs.readFile(victim, 'utf8')).toBe('keep me')
  })

  it('uses local time for the file name', async () => {
    const file = await writeManifest(destRoot, summary([]), new Date(2026, 0, 2, 3, 4))
    expect(path.basename(file)).toBe('_seznam_souboru_2026-01-02_03-04.csv')
  })
})
