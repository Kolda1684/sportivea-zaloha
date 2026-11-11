import { describe, expect, it } from 'vitest'
import { assignLocalNames, caseKey, classifyMime, sanitizeName, withSuffix } from '../../../src/core/download/names'

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

describe('sanitizeName', () => {
  it('replaces forbidden characters with a dash', () => {
    expect(sanitizeName('a/b:c*.mp4')).toBe('a-b-c-.mp4')
    expect(sanitizeName('a\\b?c"d<e>f|g')).toBe('a-b-c-d-e-f-g')
  })

  it('replaces control characters', () => {
    expect(sanitizeName('a\u0000b\u001fc\u007fd.txt')).toBe('a-b-c-d.txt')
  })

  it('trims trailing spaces and dots', () => {
    expect(sanitizeName('x. ')).toBe('x')
    expect(sanitizeName('x .. ')).toBe('x')
  })

  it('falls back for empty names', () => {
    expect(sanitizeName('')).toBe('bez názvu')
    expect(sanitizeName(' . ')).toBe('bez názvu')
    expect(sanitizeName('..')).toBe('bez názvu')
  })

  it('normalizes to NFC', () => {
    const nfd = 'Zápas'
    expect(nfd).not.toBe('Zápas')
    expect(sanitizeName(nfd)).toBe('Zápas')
  })

  it('replaces lone surrogates so the name is well-formed', () => {
    const out = sanitizeName('a\ud800b.txt')
    expect(out).toBe('a\uFFFDb.txt')
    expect(out.isWellFormed()).toBe(true)
  })

  it('truncates long names to 255 bytes and keeps the extension', () => {
    const out = sanitizeName(`${'a'.repeat(296)}.MP4`)
    expect(bytes(out)).toBeLessThanOrEqual(255)
    expect(out.endsWith('.MP4')).toBe(true)
  })

  it('never cuts a multi-byte character in half', () => {
    const out = sanitizeName(`${'ž'.repeat(200)}.mp4`)
    expect(bytes(out)).toBeLessThanOrEqual(255)
    expect(out.endsWith('.mp4')).toBe(true)
    expect(out).not.toContain('�')
    expect(/^ž+\.mp4$/.test(out)).toBe(true)
    const emoji = sanitizeName(`${'😀'.repeat(100)}.mp4`)
    expect(bytes(emoji)).toBeLessThanOrEqual(255)
    expect(/^(😀)+\.mp4$/.test(emoji)).toBe(true)
  })

  it('truncates a long name without extension', () => {
    const out = sanitizeName('b'.repeat(400))
    expect(bytes(out)).toBe(255)
  })

  it('does not leave trailing dots or spaces after truncation', () => {
    const out = sanitizeName(`${'a'.repeat(250)}. .mp4`)
    expect(bytes(out)).toBeLessThanOrEqual(255)
    expect(out.endsWith('.mp4')).toBe(true)
    expect(out).not.toMatch(/[ .]\.mp4$/)
  })
})

describe('assignLocalNames', () => {
  it('suffixes case-insensitive duplicates by createdTime, then id', () => {
    const names = assignLocalNames([
      { id: 'b', name: 'Clip.MP4', createdTime: '2026-01-01T10:00:01Z' },
      { id: 'a', name: 'clip.mp4', createdTime: '2026-01-01T10:00:01Z' },
      { id: 'c', name: 'Clip.MP4', createdTime: '2026-01-01T10:00:00Z' },
    ])
    expect(names.get('c')).toBe('Clip.MP4')
    expect(names.get('a')).toBe('clip (2).mp4')
    expect(names.get('b')).toBe('Clip (3).MP4')
  })

  it('does not collide with an existing suffixed name', () => {
    const names = assignLocalNames([
      { id: '1', name: 'A (2).txt', createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: 'A.txt', createdTime: '2026-01-02T00:00:00Z' },
      { id: '3', name: 'A.txt', createdTime: '2026-01-03T00:00:00Z' },
    ])
    expect(names.get('1')).toBe('A (2).txt')
    expect(names.get('2')).toBe('A.txt')
    expect(names.get('3')).toBe('A (3).txt')
  })

  it('treats the existing suffixed name case-insensitively', () => {
    const names = assignLocalNames([
      { id: '1', name: 'a (2).TXT', createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: 'A.txt', createdTime: '2026-01-02T00:00:00Z' },
      { id: '3', name: 'a.txt', createdTime: '2026-01-03T00:00:00Z' },
    ])
    expect(names.get('3')).toBe('a (3).txt')
  })

  it('is independent of input order', () => {
    const items = [
      { id: 'b', name: 'Clip.MP4', createdTime: '2026-01-01T10:00:01Z' },
      { id: 'a', name: 'clip.mp4', createdTime: '2026-01-01T10:00:01Z' },
      { id: 'c', name: 'Clip.MP4', createdTime: '2026-01-01T10:00:00Z' },
      { id: 'd', name: 'A (2).txt', createdTime: '2026-01-01T00:00:00Z' },
      { id: 'e', name: 'A.txt', createdTime: '2026-01-02T00:00:00Z' },
      { id: 'f', name: 'A.txt', createdTime: '2026-01-03T00:00:00Z' },
    ]
    const forward = assignLocalNames(items)
    const reversed = assignLocalNames([...items].reverse())
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort())
  })

  it('sanitizes names before grouping', () => {
    const names = assignLocalNames([
      { id: '1', name: 'a/b.txt', createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: 'a:b.txt', createdTime: '2026-01-02T00:00:00Z' },
    ])
    expect(names.get('1')).toBe('a-b.txt')
    expect(names.get('2')).toBe('a-b (2).txt')
  })

  it('puts the suffix at the end for names without extension and for dotfiles', () => {
    const names = assignLocalNames([
      { id: '1', name: 'Notes', createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: 'notes', createdTime: '2026-01-02T00:00:00Z' },
      { id: '3', name: '.hidden', createdTime: '2026-01-01T00:00:00Z' },
      { id: '4', name: '.Hidden', createdTime: '2026-01-02T00:00:00Z' },
    ])
    expect(names.get('2')).toBe('notes (2)')
    expect(names.get('4')).toBe('.Hidden (2)')
  })

  it('puts the suffix before the last extension only', () => {
    const names = assignLocalNames([
      { id: '1', name: 'a.tar.gz', createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: 'A.tar.gz', createdTime: '2026-01-02T00:00:00Z' },
    ])
    expect(names.get('2')).toBe('A.tar (2).gz')
  })

  it('keeps suffixed names within 255 bytes', () => {
    const long = `${'ž'.repeat(125)}.mp4`
    const names = assignLocalNames([
      { id: '1', name: long, createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: long.toUpperCase(), createdTime: '2026-01-02T00:00:00Z' },
      { id: '3', name: long, createdTime: '2026-01-03T00:00:00Z' },
    ])
    for (const id of ['1', '2', '3']) {
      const name = names.get(id) ?? ''
      expect(bytes(name)).toBeLessThanOrEqual(255)
      expect(name.endsWith('.mp4') || name.endsWith('.MP4')).toBe(true)
    }
    const lowered = [...names.values()].map((n) => n.toLowerCase())
    expect(new Set(lowered).size).toBe(3)
    expect(names.get('2')).toMatch(/ \(2\)\.MP4$/)
    expect(names.get('3')).toMatch(/ \(3\)\.mp4$/)
  })

  it('keeps suffixed names within 255 bytes when the name is already at the limit', () => {
    const base = sanitizeName(`${'a'.repeat(300)}.mp4`)
    expect(bytes(base)).toBeLessThanOrEqual(255)
    const names = assignLocalNames([
      { id: '1', name: base, createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: base.toUpperCase(), createdTime: '2026-01-02T00:00:00Z' },
    ])
    expect(names.get('1')).toBe(base)
    const second = names.get('2') ?? ''
    expect(bytes(second)).toBeLessThanOrEqual(255)
    expect(second.endsWith(' (2).MP4')).toBe(true)
  })

  it('groups names that differ only by Greek final sigma casing', () => {
    const names = assignLocalNames([
      { id: '1', name: '\u0391\u03a3', createdTime: '2026-01-01T00:00:00Z' },
      { id: '2', name: '\u03b1\u03c3', createdTime: '2026-01-02T00:00:00Z' },
    ])
    expect(names.get('1')).toBe('\u0391\u03a3')
    expect(names.get('2')).toBe('\u03b1\u03c3 (2)')
  })

  it('returns an entry for every item', () => {
    const names = assignLocalNames([{ id: 'x', name: 'f.txt', createdTime: '2026-01-01T00:00:00Z' }])
    expect([...names.keys()]).toEqual(['x'])
  })
})

describe('withSuffix', () => {
  it('puts " (n)" before the extension, like the scan does', () => {
    expect(withSuffix('X.mp4', 2)).toBe('X (2).mp4')
    expect(withSuffix('notes', 3)).toBe('notes (3)')
    expect(withSuffix('.hidden', 2)).toBe('.hidden (2)')
  })

  it('shortens the stem so the name stays within 255 bytes', () => {
    const out = withSuffix(`${'č'.repeat(200)}.mp4`, 12)
    expect(bytes(out)).toBeLessThanOrEqual(255)
    expect(out.endsWith(' (12).mp4')).toBe(true)
  })
})

describe('caseKey', () => {
  it('folds case with upper then lower', () => {
    expect(caseKey('A (2).MP4')).toBe(caseKey('a (2).mp4'))
    expect(caseKey('\u03b1\u03c2')).toBe(caseKey('\u0391\u03a3'))
  })
})

describe('classifyMime', () => {
  it('exports Google Docs, Sheets, Slides and Drawings', () => {
    expect(classifyMime('application/vnd.google-apps.document')).toEqual({
      kind: 'export',
      exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: '.docx',
      skipReason: null,
    })
    expect(classifyMime('application/vnd.google-apps.spreadsheet')).toEqual({
      kind: 'export',
      exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: '.xlsx',
      skipReason: null,
    })
    expect(classifyMime('application/vnd.google-apps.presentation')).toEqual({
      kind: 'export',
      exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: '.pptx',
      skipReason: null,
    })
    expect(classifyMime('application/vnd.google-apps.drawing')).toEqual({
      kind: 'export',
      exportMime: 'image/png',
      extension: '.png',
      skipReason: null,
    })
  })

  it('skips shortcuts', () => {
    expect(classifyMime('application/vnd.google-apps.shortcut')).toEqual({
      kind: 'skip',
      exportMime: null,
      extension: null,
      skipReason: 'zástupce (nestahuje se)',
    })
  })

  it('skips other Google file types', () => {
    for (const mime of ['application/vnd.google-apps.form', 'application/vnd.google-apps.site']) {
      expect(classifyMime(mime)).toEqual({
        kind: 'skip',
        exportMime: null,
        extension: null,
        skipReason: 'tento typ Google souboru nejde stáhnout',
      })
    }
  })

  it('downloads everything else as a file', () => {
    for (const mime of ['video/mp4', 'application/pdf', 'application/octet-stream', 'constructor']) {
      expect(classifyMime(mime)).toEqual({
        kind: 'file',
        exportMime: null,
        extension: null,
        skipReason: null,
      })
    }
  })
})
