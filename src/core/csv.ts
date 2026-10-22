import * as fs from 'node:fs/promises'

export type MappingRow = { original: string; newName: string; folder: string; note: string }

const HEADER = ['puvodni_nazev', 'novy_nazev', 'slozka', 'poznamka']
const BOM = '﻿'
const EOL = '\r\n'
const FORMULA_START = /^[=+\-@\t\r]/

function cell(value: string): string {
  // A spreadsheet would run a cell that starts with = + - @ as a formula: mark it as text.
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * Writes the mapping report: `;`-separated, UTF-8 with BOM (Excel), header `puvodni_nazev;novy_nazev;slozka;poznamka`.
 * Add-only: the file is created exclusively and an existing file makes this reject with `EEXIST`.
 */
export async function writeMappingCsv(file: string, rows: MappingRow[]): Promise<void> {
  const lines = [HEADER, ...rows.map((r) => [r.original, r.newName, r.folder, r.note])].map((fields) =>
    fields.map(cell).join(';'),
  )
  await fs.writeFile(file, BOM + lines.join(EOL) + EOL, { encoding: 'utf8', flag: 'wx' })
}
