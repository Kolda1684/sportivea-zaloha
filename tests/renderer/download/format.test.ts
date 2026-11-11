import { describe, expect, it } from 'vitest'
import { baseName, eta, formatBytes, formatCount, formatDate, formatDuration, formatSpeed, plural } from '../../../src/renderer/download/format'

const NB = '\u00a0'

describe('formatBytes', () => {
  it('formats small values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('uses decimal units, a decimal comma and three significant digits', () => {
    expect(formatBytes(1500)).toBe('1,5 kB')
    expect(formatBytes(1_000_000)).toBe('1 MB')
    expect(formatBytes(12_345_678_901)).toBe('12,3 GB')
    expect(formatBytes(1_020_000_000_000)).toBe('1,02 TB')
    expect(formatBytes(210_000_000_000)).toBe('210 GB')
  })

  it('moves to the next unit when rounding reaches 1000', () => {
    expect(formatBytes(999_999)).toBe('1 MB')
    expect(formatBytes(999_950_000)).toBe('1 GB')
  })

  it('treats invalid input as zero', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatDuration', () => {
  it('shows hours and minutes, minutes and seconds, or seconds', () => {
    expect(formatDuration(8100)).toBe('2 h 15 min')
    expect(formatDuration(3600)).toBe('1 h')
    expect(formatDuration(125)).toBe('2 min 5 s')
    expect(formatDuration(40)).toBe('40 s')
    expect(formatDuration(0)).toBe('0 s')
  })

  it('rounds up to whole minutes once it is an hour or more', () => {
    expect(formatDuration(3599.4)).toBe('59 min 59 s')
    expect(formatDuration(8130)).toBe('2 h 16 min')
  })

  it('treats invalid input as zero', () => {
    expect(formatDuration(-3)).toBe('0 s')
    expect(formatDuration(Number.NaN)).toBe('0 s')
  })
})

describe('formatSpeed', () => {
  it('appends /s to the byte format', () => {
    expect(formatSpeed(85_300_000)).toBe('85,3 MB/s')
    expect(formatSpeed(0)).toBe('0 B/s')
  })
})

describe('eta', () => {
  it('divides the remaining bytes by the speed and rounds up', () => {
    expect(eta(0, 1000, 100)).toBe(10)
    expect(eta(950, 1000, 100)).toBe(1)
  })

  it('is null when it cannot be estimated', () => {
    expect(eta(0, 1000, 0)).toBeNull()
    expect(eta(0, 1000, Number.NaN)).toBeNull()
    expect(eta(0, 0, 100)).toBeNull()
  })

  it('is 0 when everything is done', () => {
    expect(eta(1000, 1000, 100)).toBe(0)
  })
})

describe('formatCount', () => {
  it('groups thousands with a non-breaking space', () => {
    expect(formatCount(7)).toBe('7')
    expect(formatCount(1234)).toBe(`1${NB}234`)
    expect(formatCount(1_234_567)).toBe(`1${NB}234${NB}567`)
  })
})

describe('plural', () => {
  it('picks the Czech form', () => {
    expect(plural(1, 'soubor', 'soubory', 'souborů')).toBe('soubor')
    expect(plural(3, 'soubor', 'soubory', 'souborů')).toBe('soubory')
    expect(plural(0, 'soubor', 'soubory', 'souborů')).toBe('souborů')
    expect(plural(5, 'soubor', 'soubory', 'souborů')).toBe('souborů')
  })
})

describe('formatDate', () => {
  it('shows the local date as day. month. year', () => {
    expect(formatDate(new Date(2026, 9, 20, 9, 0).toISOString())).toBe('20. 10. 2026')
  })

  it('returns null for missing or invalid input', () => {
    expect(formatDate(null)).toBeNull()
    expect(formatDate('not a date')).toBeNull()
  })
})

describe('baseName', () => {
  it('returns the last path segment', () => {
    expect(baseName('/Volumes/Disk/Složka/_seznam.csv')).toBe('_seznam.csv')
    expect(baseName('soubor.csv')).toBe('soubor.csv')
  })
})
