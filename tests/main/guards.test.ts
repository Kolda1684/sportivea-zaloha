import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveInsideRoot, RootFolderGuard } from '../../src/main/guards'

let base: string
let root: string
let outside: string

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-guards-')))
  root = path.join(base, 'drive')
  outside = path.join(base, 'outside')
  await fs.mkdir(path.join(root, 'Akce'), { recursive: true })
  await fs.mkdir(outside)
})
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('resolveInsideRoot', () => {
  it('accepts the root itself and folders below it', async () => {
    expect(await resolveInsideRoot(root, root)).toBe(root)
    expect(await resolveInsideRoot(root, path.join(root, 'Akce'))).toBe(path.join(root, 'Akce'))
  })

  it('rejects paths outside the root, sibling prefixes and ..', async () => {
    await fs.mkdir(path.join(base, 'drive-evil'))
    expect(await resolveInsideRoot(root, outside)).toBeNull()
    expect(await resolveInsideRoot(root, path.join(base, 'drive-evil'))).toBeNull()
    expect(await resolveInsideRoot(root, path.join(root, '..', 'outside'))).toBeNull()
  })

  it('rejects a symlink inside the root that points outside', async () => {
    await fs.symlink(outside, path.join(root, 'link'))
    expect(await resolveInsideRoot(root, path.join(root, 'link'))).toBeNull()
  })

  it('accepts the root given through a symlink', async () => {
    const viaLink = path.join(base, 'rootlink')
    await fs.symlink(root, viaLink)
    expect(await resolveInsideRoot(viaLink, path.join(root, 'Akce'))).toBe(path.join(root, 'Akce'))
  })

  it('rejects null root, relative paths and missing targets', async () => {
    expect(await resolveInsideRoot(null, root)).toBeNull()
    expect(await resolveInsideRoot(root, 'Akce')).toBeNull()
    expect(await resolveInsideRoot(root, path.join(root, 'neexistuje'))).toBeNull()
  })
})

describe('RootFolderGuard', () => {
  it('refuses any new root before the user has picked one', async () => {
    const g = new RootFolderGuard()
    expect(await g.allows(outside, null)).toBe(false)
    expect(await g.allows('/', null)).toBe(false)
  })

  it('allows null and the unchanged current value', async () => {
    const g = new RootFolderGuard()
    expect(await g.allows(null, root)).toBe(true)
    expect(await g.allows(root, root)).toBe(true)
  })

  it('allows exactly the folder picked in the dialog, also via a symlink, and nothing else', async () => {
    const g = new RootFolderGuard()
    await g.recordPick(root)
    expect(await g.allows(root, null)).toBe(true)
    const viaLink = path.join(base, 'rootlink')
    await fs.symlink(root, viaLink)
    expect(await g.allows(viaLink, null)).toBe(true)
    expect(await g.allows(outside, null)).toBe(false)
    expect(await g.allows(path.join(root, 'Akce'), null)).toBe(false)
  })

  it('a later pick replaces the earlier one', async () => {
    const g = new RootFolderGuard()
    await g.recordPick(root)
    await g.recordPick(outside)
    expect(await g.allows(root, null)).toBe(false)
    expect(await g.allows(outside, null)).toBe(true)
  })
})
