import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATES } from '../../../src/core/cards/templates'
import { defaultSettings, loadSettings, parseSettingsPatch, saveSettings } from '../../../src/main/cards/settings'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-settings-'))
  file = path.join(dir, 'settings.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('loadSettings', () => {
  it('returns the documented defaults when the file does not exist', async () => {
    expect(await loadSettings(file)).toEqual({
      rootDir: null,
      model: 'claude-sonnet-5-5',
      templates: DEFAULT_TEMPLATES,
      lastTemplateId: 'fotbal',
      rosters: {},
      lumaThreshold: 0.2,
      czkPerUsd: 23,
    })
  })

  it('falls back to the default for an invalid field and keeps the valid ones', async () => {
    await fs.writeFile(file, JSON.stringify({ rootDir: '/Volumes/Drive/Akce', lumaThreshold: 'x', czkPerUsd: 25 }))
    const s = await loadSettings(file)
    expect(s.lumaThreshold).toBe(0.2)
    expect(s.rootDir).toBe('/Volumes/Drive/Akce')
    expect(s.czkPerUsd).toBe(25)
  })

  it('ignores unknown fields and unknown models', async () => {
    await fs.writeFile(file, JSON.stringify({ model: 'gpt-9', extra: 1, lastTemplateId: 'tenis' }))
    const s = await loadSettings(file)
    expect(s.model).toBe('claude-sonnet-5-5')
    expect(s.lastTemplateId).toBe('tenis')
    expect('extra' in s).toBe(false)
  })

  it('falls back to default templates when the stored ones are malformed or empty', async () => {
    await fs.writeFile(file, JSON.stringify({ templates: [{ id: 'x' }] }))
    expect((await loadSettings(file)).templates).toEqual(DEFAULT_TEMPLATES)
    await fs.writeFile(file, JSON.stringify({ templates: [] }))
    expect((await loadSettings(file)).templates).toEqual(DEFAULT_TEMPLATES)
  })

  it('rejects category names that are not plain folder names', async () => {
    const bad = [{ id: 'x', name: 'X', categories: [{ name: '../evil', hint: 'h' }] }]
    await fs.writeFile(file, JSON.stringify({ templates: bad }))
    expect((await loadSettings(file)).templates).toEqual(DEFAULT_TEMPLATES)
  })

  it('returns defaults for a corrupted (non-JSON) file', async () => {
    await fs.writeFile(file, '{not json')
    expect(await loadSettings(file)).toEqual(defaultSettings())
  })

  it('returns defaults for JSON that is not an object', async () => {
    await fs.writeFile(file, '[1,2]')
    expect(await loadSettings(file)).toEqual(defaultSettings())
  })

  it('does not share default objects between calls', async () => {
    const a = await loadSettings(file)
    a.rosters['x'] = 'y'
    a.templates.pop()
    const b = await loadSettings(file)
    expect(b.rosters).toEqual({})
    expect(b.templates).toEqual(DEFAULT_TEMPLATES)
  })
})

describe('saveSettings', () => {
  it('round-trips and creates the parent directory', async () => {
    const nested = path.join(dir, 'a', 'b', 'settings.json')
    const s = { ...defaultSettings(), rootDir: '/x', rosters: { Sparta: '9 Kačor' }, czkPerUsd: 24.5 }
    await saveSettings(nested, s)
    expect(await loadSettings(nested)).toEqual(s)
  })

  it('leaves no temp file behind', async () => {
    await saveSettings(file, defaultSettings())
    expect(await fs.readdir(dir)).toEqual(['settings.json'])
  })
})

describe('parseSettingsPatch', () => {
  it('accepts a partial valid patch', () => {
    expect(parseSettingsPatch({ czkPerUsd: 22, rootDir: null })).toEqual({ ok: true, patch: { czkPerUsd: 22, rootDir: null } })
  })

  it('rejects an invalid field instead of silently defaulting', () => {
    expect(parseSettingsPatch({ lumaThreshold: 'x' }).ok).toBe(false)
    expect(parseSettingsPatch({ lumaThreshold: 5 }).ok).toBe(false)
    expect(parseSettingsPatch({ czkPerUsd: -1 }).ok).toBe(false)
    expect(parseSettingsPatch({ model: 'other' }).ok).toBe(false)
  })

  it('rejects unknown keys and non-objects', () => {
    expect(parseSettingsPatch({ apiKey: 'sk-secret' }).ok).toBe(false)
    expect(parseSettingsPatch('x').ok).toBe(false)
    expect(parseSettingsPatch(null).ok).toBe(false)
  })
})
