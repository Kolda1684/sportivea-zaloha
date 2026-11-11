import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { importTrideniData } from '../../src/main/migrate'

let base: string
let fromDir: string
let toDir: string
let logs: string[]

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'zaloha-migrate-'))
  fromDir = path.join(base, 'trideni-karet')
  toDir = path.join(base, 'sportivea-zaloha')
  await fs.mkdir(fromDir)
  await fs.mkdir(toDir)
  logs = []
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

const run = () => importTrideniData({ fromDir, toDir, log: (m) => logs.push(m) })

it('copies settings and journal when the target has none', async () => {
  await fs.writeFile(path.join(fromDir, 'settings.json'), '{"model":"claude-haiku-5-5"}')
  await fs.writeFile(path.join(fromDir, 'journal.jsonl'), '{"a":1}\n')
  const before = await fs.stat(path.join(fromDir, 'settings.json'))
  const result = await run()
  expect(result.imported.sort()).toEqual(['journal.jsonl', 'settings.json'])
  expect(await fs.readFile(path.join(toDir, 'settings.json'), 'utf8')).toBe('{"model":"claude-haiku-5-5"}')
  expect(await fs.readFile(path.join(toDir, 'journal.jsonl'), 'utf8')).toBe('{"a":1}\n')
  const after = await fs.stat(path.join(fromDir, 'settings.json'))
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(await fs.readFile(path.join(fromDir, 'settings.json'), 'utf8')).toBe('{"model":"claude-haiku-5-5"}')
})

it('never overwrites an existing target file', async () => {
  await fs.writeFile(path.join(fromDir, 'settings.json'), 'old app')
  await fs.writeFile(path.join(toDir, 'settings.json'), 'new app')
  const result = await run()
  expect(result.imported).toEqual([])
  expect(await fs.readFile(path.join(toDir, 'settings.json'), 'utf8')).toBe('new app')
})

it('missing source is fine', async () => {
  await fs.rm(fromDir, { recursive: true })
  expect(await run()).toEqual({ imported: [] })
})

it('does not follow a symlinked source', async () => {
  const elsewhere = path.join(base, 'elsewhere.json')
  await fs.writeFile(elsewhere, '{}')
  await fs.symlink(elsewhere, path.join(fromDir, 'settings.json'))
  expect(await run()).toEqual({ imported: [] })
  await expect(fs.lstat(path.join(toDir, 'settings.json'))).rejects.toThrow()
})

it('never copies apikey.bin', async () => {
  await fs.writeFile(path.join(fromDir, 'apikey.bin'), 'encrypted')
  await run()
  await expect(fs.lstat(path.join(toDir, 'apikey.bin'))).rejects.toThrow()
})

it('imports only once: a later start copies nothing again', async () => {
  await fs.writeFile(path.join(fromDir, 'settings.json'), '{}')
  expect((await run()).imported).toEqual(['settings.json'])
  await fs.rm(path.join(toDir, 'settings.json'))
  await fs.writeFile(path.join(fromDir, 'journal.jsonl'), '{"a":1}\n')
  expect(await run()).toEqual({ imported: [] })
  await expect(fs.lstat(path.join(toDir, 'settings.json'))).rejects.toThrow()
})

it('creates a missing target folder instead of skipping the import', async () => {
  await fs.rm(toDir, { recursive: true })
  await fs.writeFile(path.join(fromDir, 'settings.json'), '{}')
  expect((await run()).imported).toEqual(['settings.json'])
})
