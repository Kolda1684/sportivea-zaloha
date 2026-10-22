import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Journal, type JournalEntry } from '../../src/core/journal'

let dir: string
let file: string

const e1: JournalEntry = {
  sha256: 'a'.repeat(64),
  size: 100,
  originalRelPath: 'PRIVATE/M4ROOT/CLIP/C0001.MP4',
  eventDir: '/drive/2026-10-22 Turnaj',
  destPath: '/drive/2026-10-22 Turnaj/gol/C0001_gol.MP4',
  at: '2026-10-22T10:00:00.000Z',
}
const e2: JournalEntry = {
  sha256: 'b'.repeat(64),
  size: 200,
  originalRelPath: 'PRIVATE/M4ROOT/CLIP/C0002.MP4',
  eventDir: '/drive/2026-10-22 Turnaj',
  destPath: '/drive/2026-10-22 Turnaj/_nezarazeno/C0002.MP4',
  at: '2026-10-22T10:01:00.000Z',
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-journal-'))
  file = path.join(dir, 'journal.jsonl')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('Journal', () => {
  it('loads an empty journal when the file is missing', async () => {
    const j = await Journal.load(path.join(dir, 'nope', 'journal.jsonl'))
    expect(j.find(e1.eventDir, e1.sha256, e1.size)).toBeUndefined()
  })

  it('persists appended entries and finds them after reload', async () => {
    const j = await Journal.load(file)
    await j.append(e1)
    await j.append(e2)
    expect(j.find(e1.eventDir, e1.sha256, e1.size)).toEqual(e1)

    const again = await Journal.load(file)
    expect(again.find(e1.eventDir, e1.sha256, e1.size)).toEqual(e1)
    expect(again.find(e2.eventDir, e2.sha256, e2.size)).toEqual(e2)
    expect(again.findByOriginal(e2.eventDir, e2.originalRelPath, e2.size)).toEqual(e2)
  })

  it('does not match a different event, size or hash', async () => {
    const j = await Journal.load(file)
    await j.append(e1)
    expect(j.find('/other', e1.sha256, e1.size)).toBeUndefined()
    expect(j.find(e1.eventDir, e1.sha256, 101)).toBeUndefined()
    expect(j.find(e1.eventDir, 'c'.repeat(64), e1.size)).toBeUndefined()
    expect(j.findByOriginal(e1.eventDir, e1.originalRelPath, 99)).toBeUndefined()
    expect(j.findByOriginal('/other', e1.originalRelPath, e1.size)).toBeUndefined()
  })

  it('ignores a truncated last line and keeps the complete lines', async () => {
    await fs.writeFile(file, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n{"sha256":"ab`)
    const j = await Journal.load(file)
    expect(j.find(e1.eventDir, e1.sha256, e1.size)).toEqual(e1)
    expect(j.find(e2.eventDir, e2.sha256, e2.size)).toEqual(e2)
  })

  it('appending after a truncated tail does not corrupt the new entry', async () => {
    await fs.writeFile(file, `${JSON.stringify(e1)}\n{"sha256":"ab`)
    const j = await Journal.load(file)
    await j.append(e2)
    const again = await Journal.load(file)
    expect(again.find(e1.eventDir, e1.sha256, e1.size)).toEqual(e1)
    expect(again.find(e2.eventDir, e2.sha256, e2.size)).toEqual(e2)
  })

  it('skips lines that parse but are not journal entries', async () => {
    await fs.writeFile(file, `{"foo":1}\n${JSON.stringify(e1)}\n\n[1,2]\n`)
    const j = await Journal.load(file)
    expect(j.find(e1.eventDir, e1.sha256, e1.size)).toEqual(e1)
  })

  it('creates the parent folder on first append and appends concurrently without loss', async () => {
    const nested = path.join(dir, 'a', 'b', 'journal.jsonl')
    const j = await Journal.load(nested)
    await Promise.all([j.append(e1), j.append(e2)])
    const again = await Journal.load(nested)
    expect(again.find(e1.eventDir, e1.sha256, e1.size)).toEqual(e1)
    expect(again.find(e2.eventDir, e2.sha256, e2.size)).toEqual(e2)
  })
})
