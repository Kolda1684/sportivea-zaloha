import type { EntryKind } from './types'

const MAX_NAME_BYTES = 255
/** A trailing ".something" longer than this is not treated as a file extension. */
const MAX_EXTENSION_BYTES = 32
const FALLBACK_NAME = 'bez názvu'

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g

/** Case-insensitive comparison key (upper then lower, so e.g. Greek final sigma folds together). */
export const caseKey = (s: string): string => s.toUpperCase().toLowerCase()

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

/** Cuts to at most `maxBytes` UTF-8 bytes, only at code point boundaries. */
function limitBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const size = byteLength(ch)
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}

/** Splits at the LAST dot. A leading dot (".hidden") or an over-long tail means no extension. */
function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  const ext = name.slice(dot)
  if (byteLength(ext) > MAX_EXTENSION_BYTES) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext }
}

const trimTrailing = (s: string): string => s.replace(/[ .]+$/, '')

/** stem + suffix + ext, with the stem shortened so the whole name fits in 255 bytes. */
function fitName(stem: string, suffix: string, ext: string): string {
  const budget = MAX_NAME_BYTES - byteLength(suffix) - byteLength(ext)
  if (byteLength(stem) <= budget) return stem + suffix + ext
  let cut = suffix === '' ? trimTrailing(limitBytes(stem, budget)) : limitBytes(stem, budget)
  if (cut === '') cut = '-'
  return cut + suffix + ext
}

export function sanitizeName(name: string): string {
  const cleaned = trimTrailing(name.toWellFormed().normalize('NFC').replace(FORBIDDEN, '-'))
  if (cleaned === '') return FALLBACK_NAME
  const { stem, ext } = splitExtension(cleaned)
  return fitName(stem, '', ext)
}

/** The ` (n)` variant of an already sanitized name, with the same suffix and length rules as `assignLocalNames`. */
export function withSuffix(name: string, n: number): string {
  const { stem, ext } = splitExtension(name)
  return fitName(stem, ` (${n})`, ext)
}

export function assignLocalNames(
  items: { id: string; name: string; createdTime: string }[],
): Map<string, string> {
  const sanitized = items.map((item) => ({
    id: item.id,
    createdTime: item.createdTime,
    name: sanitizeName(item.name),
  }))

  const taken = new Set<string>(sanitized.map((item) => caseKey(item.name)))
  const groups = new Map<string, typeof sanitized>()
  for (const item of sanitized) {
    const key = caseKey(item.name)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }

  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const result = new Map<string, string>()
  for (const key of [...groups.keys()].sort(compare)) {
    const group = (groups.get(key) ?? []).sort(
      (a, b) => compare(a.createdTime, b.createdTime) || compare(a.id, b.id),
    )
    group.forEach((item, index) => {
      if (index === 0) {
        result.set(item.id, item.name)
        return
      }
      for (let n = index + 1; ; n += 1) {
        const candidate = withSuffix(item.name, n)
        const lowered = caseKey(candidate)
        if (!taken.has(lowered)) {
          taken.add(lowered)
          result.set(item.id, candidate)
          return
        }
      }
    })
  }
  return result
}

const GOOGLE_APPS = 'application/vnd.google-apps.'

const EXPORTS = new Map<string, { exportMime: string; extension: string }>([
  [`${GOOGLE_APPS}document`, { exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx' }],
  [`${GOOGLE_APPS}spreadsheet`, { exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' }],
  [`${GOOGLE_APPS}presentation`, { exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx' }],
  [`${GOOGLE_APPS}drawing`, { exportMime: 'image/png', extension: '.png' }],
])

export function classifyMime(mimeType: string): {
  kind: EntryKind
  exportMime: string | null
  extension: string | null
  skipReason: string | null
} {
  const exported = EXPORTS.get(mimeType)
  if (exported) {
    return { kind: 'export', exportMime: exported.exportMime, extension: exported.extension, skipReason: null }
  }
  if (mimeType === `${GOOGLE_APPS}shortcut`) {
    return { kind: 'skip', exportMime: null, extension: null, skipReason: 'zástupce (nestahuje se)' }
  }
  if (mimeType.startsWith(GOOGLE_APPS)) {
    return {
      kind: 'skip',
      exportMime: null,
      extension: null,
      skipReason: 'tento typ Google souboru nejde stáhnout',
    }
  }
  return { kind: 'file', exportMime: null, extension: null, skipReason: null }
}
