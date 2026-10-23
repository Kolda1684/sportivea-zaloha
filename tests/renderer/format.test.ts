import { describe, expect, it } from 'vitest'
import { baseName, defaultEventName, drivePath, formatBytes, formatCzk, formatDateRange, plural, classifyFailureMessage } from '../../src/renderer/format'

const NB = ' '

describe('formatBytes', () => {
  it('formats small values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('uses decimal units and a decimal comma', () => {
    expect(formatBytes(1500)).toBe('1,5 kB')
    expect(formatBytes(1_000_000)).toBe('1 MB')
    expect(formatBytes(12_345_678_901)).toBe('12,3 GB')
  })

  it('drops the decimals from three-digit values', () => {
    expect(formatBytes(250_000_000_000)).toBe('250 GB')
    expect(formatBytes(1_500_000_000_000)).toBe('1,5 TB')
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

describe('formatCzk', () => {
  it('shows crowns with two decimals below 100', () => {
    expect(formatCzk(2.345)).toBe(`2,35${NB}Kč`)
    expect(formatCzk(0.4)).toBe(`0,40${NB}Kč`)
  })

  it('drops zero decimals', () => {
    expect(formatCzk(0)).toBe(`0${NB}Kč`)
    expect(formatCzk(5)).toBe(`5${NB}Kč`)
  })

  it('rounds to whole crowns from 100 up and groups thousands', () => {
    expect(formatCzk(100.4)).toBe(`100${NB}Kč`)
    expect(formatCzk(1234.5)).toBe(`1${NB}235${NB}Kč`)
    expect(formatCzk(1_234_567)).toBe(`1${NB}234${NB}567${NB}Kč`)
  })

  it('does not show 100,00 for values that round up to 100', () => {
    expect(formatCzk(99.996)).toBe(`100${NB}Kč`)
  })

  it('treats invalid input as zero', () => {
    expect(formatCzk(-1)).toBe(`0${NB}Kč`)
    expect(formatCzk(Number.NaN)).toBe(`0${NB}Kč`)
  })
})

describe('defaultEventName', () => {
  it('is the local date followed by a space, ready for the user to type the name', () => {
    expect(defaultEventName(new Date(2026, 9, 20, 23, 59))).toBe('2026-10-20 ')
    expect(defaultEventName(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05 ')
  })
})

describe('formatDateRange', () => {
  it('shows one date for a single day', () => {
    const a = new Date(2026, 9, 20, 9, 0).toISOString()
    const b = new Date(2026, 9, 20, 18, 30).toISOString()
    expect(formatDateRange(a, b)).toBe('20. 10. 2026')
  })

  it('shows a range for several days', () => {
    const a = new Date(2026, 9, 20, 9, 0).toISOString()
    const b = new Date(2026, 9, 21, 18, 30).toISOString()
    expect(formatDateRange(a, b)).toBe('20. 10. 2026 – 21. 10. 2026')
  })

  it('handles missing dates', () => {
    expect(formatDateRange(null, null)).toBe('neznámé')
    expect(formatDateRange('not a date', null)).toBe('neznámé')
  })
})

describe('baseName', () => {
  it('returns the last path segment', () => {
    expect(baseName('DAY 1/Trénink/A75_0413.MP4')).toBe('A75_0413.MP4')
    expect(baseName('A75_0413.MP4')).toBe('A75_0413.MP4')
    expect(baseName('/Users/x/Drive/Akce/Zápas/clip.mp4')).toBe('clip.mp4')
  })
})

describe('plural', () => {
  it('picks the Czech form', () => {
    const f = (n: number): string => plural(n, 'klip', 'klipy', 'klipů')
    expect(f(1)).toBe('klip')
    expect(f(2)).toBe('klipy')
    expect(f(4)).toBe('klipy')
    expect(f(5)).toBe('klipů')
    expect(f(0)).toBe('klipů')
    expect(f(21)).toBe('klipů')
    expect(f(104)).toBe('klipů')
  })
})

describe('classifyFailureMessage', () => {
  it('names the count and the folder', () => {
    expect(classifyFailureMessage(1)).toBe('1 klip se nepodařilo roztřídit — je ve složce _nezařazeno')
    expect(classifyFailureMessage(3)).toBe('3 klipy se nepodařilo roztřídit — jsou ve složce _nezařazeno')
    expect(classifyFailureMessage(8)).toBe('8 klipů se nepodařilo roztřídit — jsou ve složce _nezařazeno')
  })
})

describe('drivePath', () => {
  it('shows a Google Drive for desktop path from the drive root', () => {
    expect(drivePath('/Users/kolda/Library/CloudStorage/GoogleDrive-jan.kolar@sportivea.cz/Sdílené disky/Sportivea sdílený disk/Test - třídění')).toBe(
      'Google Disk › Sdílené disky › Sportivea sdílený disk › Test - třídění',
    )
    expect(drivePath('/Users/kolda/Library/CloudStorage/GoogleDrive-jan.kolar@sportivea.cz/Můj disk/Akce')).toBe('Google Disk › Můj disk › Akce')
  })

  it('keeps any other path as it is', () => {
    expect(drivePath('/Volumes/Archiv/Akce')).toBe('/Volumes/Archiv/Akce')
  })
})
