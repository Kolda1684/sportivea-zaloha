const EXTRA_ASCII: Readonly<Record<string, string>> = {
  ß: 'ss',
  ł: 'l',
  ø: 'o',
  đ: 'd',
  æ: 'ae',
  œ: 'oe',
}

/**
 * Camera clip identifier inside a file name stem. Accepted shapes:
 * `C0012`, `DSC00001` (letters + 4-5 digits), `A75_0449`, `DSC_5001`, `FX3-A_9347`
 * (alphanumeric prefix, optional `-suffix` parts, `_`, then 3-5 digits).
 * The first match wins; it must not touch other letters or digits.
 */
const CAMERA_ID =
  /(?<![\p{L}\p{N}])(?:[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*_\d{3,5}|[A-Za-z]{1,4}\d{4,5})(?![\p{L}\p{N}])/u

const LABEL_TRIM = /^[\s_-]+|[\s_-]+$/g

/** Lowercase ASCII, hyphen-joined, no diacritics, at most `maxLen` chars, no trailing hyphen. */
export function slugify(text: string, maxLen = 40): string {
  const ascii = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßłøđæœ]/g, (c) => EXTRA_ASCII[c] ?? c)
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Math.max(0, maxLen))
  return slug.replace(/-+$/g, '')
}

export function parseOriginalName(fileName: string): {
  base: string
  handLabel?: string
  ext: string
} {
  const dot = fileName.lastIndexOf('.')
  const hasExt = dot > 0
  const stem = hasExt ? fileName.slice(0, dot) : fileName
  const ext = hasExt ? fileName.slice(dot + 1) : ''

  const match = CAMERA_ID.exec(stem)
  if (!match) {
    return { base: slugify(stem), ext }
  }

  const before = stem.slice(0, match.index).replace(LABEL_TRIM, '')
  const after = stem.slice(match.index + match[0].length).replace(LABEL_TRIM, '')
  const handLabel = [before, after].filter((part) => part !== '').join(' ')
  return handLabel === '' ? { base: match[0], ext } : { base: match[0], handLabel, ext }
}

export function buildName(p: {
  base: string
  description: string
  top: boolean
  ext: string
  cameraTag?: string
}): string {
  const head = p.cameraTag ? `${p.base}-${p.cameraTag}` : p.base
  const parts = [head]
  if (p.top) parts.push('TOP')
  if (p.description !== '') parts.push(p.description)
  const stem = parts.join('_')
  return p.ext === '' ? stem : `${stem}.${p.ext}`
}

/** `C0001_gol.MP4`, 2 -> `C0001_gol (2).MP4` */
export function withConflictSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name} (${n})`
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`
}
