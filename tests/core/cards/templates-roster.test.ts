import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATES, OTHER_FILES, UNCLASSIFIED } from '../../../src/core/cards/templates'
import { parseRoster } from '../../../src/core/cards/roster'

describe('parseRoster', () => {
  it('parses number + surname lines in the supported shapes and ignores junk', () => {
    expect(parseRoster('9 Kačor\n#10 Provod\nblabla\n7 - Doudera')).toEqual([
      { number: 9, surname: 'Kačor' },
      { number: 10, surname: 'Provod' },
      { number: 7, surname: 'Doudera' },
    ])
  })

  it('handles CRLF, blank lines and multi-word surnames', () => {
    expect(parseRoster('\r\n 1 Van Der Berg \r\n\r\n12\r\n')).toEqual([
      { number: 1, surname: 'Van Der Berg' },
    ])
  })

  it('returns an empty roster for empty text', () => {
    expect(parseRoster('')).toEqual([])
  })
})

describe('DEFAULT_TEMPLATES', () => {
  it('has fotbal and tenis with the expected category names in order', () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.id)).toEqual(['fotbal', 'tenis'])
    expect(DEFAULT_TEMPLATES[0]?.categories.map((c) => c.name)).toEqual([
      'Trénink',
      'předzápas',
      'rozcvička',
      'nástup',
      'Zápas',
      'děkovačka',
    ])
    expect(DEFAULT_TEMPLATES[1]?.categories.map((c) => c.name)).toEqual([
      'Hra',
      'Fanoušci',
      'Lavička',
      'Nástup',
      'Sponzoři',
    ])
  })

  it('has a non-empty hint for every category and exports the special folder names', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const c of t.categories) expect(c.hint.length).toBeGreaterThan(0)
    }
    expect(UNCLASSIFIED).toBe('_nezařazeno')
    expect(OTHER_FILES).toBe('_ostatni')
  })
})
