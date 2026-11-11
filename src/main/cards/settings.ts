import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'
import { DEFAULT_TEMPLATES } from '../../core/cards/templates'
import type { Settings } from '../../shared/cards-ipc'

export type { Settings } from '../../shared/cards-ipc'

const plainName = (s: string): boolean => s !== '.' && s !== '..' && !/[\\/\0]/.test(s) && s.trim() === s

const templateSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  categories: z
    .array(
      z.object({
        name: z.string().min(1).max(100).refine(plainName, 'not a plain folder name'),
        hint: z.string().max(1000),
      }),
    )
    .min(1)
    .max(50),
})

/** One schema per field: the same schemas validate a stored file (per field, falling back) and an IPC patch (strict). */
const fieldSchemas = {
  rootDir: z.string().min(1).max(4096).nullable(),
  model: z.enum(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']),
  templates: z.array(templateSchema).min(1).max(50),
  lastTemplateId: z.string().min(1).max(100),
  rosters: z.record(z.string().max(200), z.string().max(20_000)),
  lumaThreshold: z.number().min(0).max(1),
  czkPerUsd: z.number().positive().max(10_000),
}

const patchSchema = z.object(fieldSchemas).partial().strict()

export function defaultSettings(): Settings {
  return {
    rootDir: null,
    model: 'claude-sonnet-5-5',
    templates: structuredClone(DEFAULT_TEMPLATES),
    lastTemplateId: 'fotbal',
    rosters: {},
    lumaThreshold: 0.2,
    czkPerUsd: 23,
  }
}

/** Takes every valid field of `raw` and the default for every missing or invalid one. */
export function parseSettings(raw: unknown): Settings {
  const result = defaultSettings()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result
  const obj = raw as Record<string, unknown>
  const target: Record<string, unknown> = result
  for (const key of Object.keys(fieldSchemas) as Array<keyof typeof fieldSchemas>) {
    if (!(key in obj)) continue
    const parsed = fieldSchemas[key].safeParse(obj[key])
    if (parsed.success) target[key] = parsed.data
  }
  return result
}

export type PatchResult = { ok: true; patch: Partial<Settings> } | { ok: false; error: string }

/** Validates a settings patch coming over IPC. Invalid input is rejected, never silently replaced. */
export function parseSettingsPatch(raw: unknown): PatchResult {
  const parsed = patchSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Neplatné nastavení.' }
  const patch: Partial<Settings> = {}
  const target: Record<string, unknown> = patch
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) target[key] = value
  }
  return { ok: true, patch }
}

export async function loadSettings(file: string): Promise<Settings> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return defaultSettings()
  }
  try {
    return parseSettings(JSON.parse(text))
  } catch {
    return defaultSettings()
  }
}

/** Writes through a temp file and a rename so that a crash never leaves a half-written settings file. */
export async function saveSettings(file: string, s: Settings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), { encoding: 'utf8' })
  try {
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}
