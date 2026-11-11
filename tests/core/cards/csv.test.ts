import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeMappingCsv } from '../../../src/core/cards/csv'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-csv-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('writeMappingCsv', () => {
  it('writes UTF-8 with BOM, ; separators and the fixed header', async () => {
    const file = path.join(dir, 'a.csv')
    await writeMappingCsv(file, [{ original: 'C0001.MP4', newName: 'C0001_gol.MP4', folder: 'Zápas', note: '' }])
    const buf = await fs.readFile(file)
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(buf.toString('utf8').slice(1)).toBe('puvodni_nazev;novy_nazev;slozka;poznamka\r\nC0001.MP4;C0001_gol.MP4;Zápas;\r\n')
  })

  it('quotes fields with separators, quotes and newlines', async () => {
    const file = path.join(dir, 'b.csv')
    await writeMappingCsv(file, [{ original: 'a;b', newName: 'say "hi"', folder: 'x', note: 'l1\nl2' }])
    expect((await fs.readFile(file, 'utf8')).slice(1).split('\r\n')[1]).toBe('"a;b";"say ""hi""";x;"l1\nl2"')
  })

  it('neutralises spreadsheet formulas', async () => {
    const file = path.join(dir, 'c.csv')
    await writeMappingCsv(file, [{ original: '=SUM(A1)', newName: '@x', folder: '+1', note: '-2' }])
    expect((await fs.readFile(file, 'utf8')).slice(1).split('\r\n')[1]).toBe("'=SUM(A1);'@x;'+1;'-2")
  })

  it('never overwrites an existing file', async () => {
    const file = path.join(dir, 'd.csv')
    await fs.writeFile(file, 'keep')
    await expect(writeMappingCsv(file, [])).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(file, 'utf8')).toBe('keep')
  })
})
