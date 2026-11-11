import { describe, expect, it } from 'vitest'
import { buildName, parseOriginalName, slugify, withConflictSuffix } from '../../../src/core/cards/naming'

describe('parseOriginalName', () => {
  it('splits a trailing hand label after the camera number', () => {
    expect(parseOriginalName('FX3-A_9347_šance.MP4')).toEqual({
      base: 'FX3-A_9347',
      handLabel: 'šance',
      ext: 'MP4',
    })
  })

  it('keeps plain camera names as base', () => {
    expect(parseOriginalName('A75_0449.MP4')).toEqual({ base: 'A75_0449', ext: 'MP4' })
    expect(parseOriginalName('C0012.MP4')).toEqual({ base: 'C0012', ext: 'MP4' })
    expect(parseOriginalName('DSC_5001.MOV')).toEqual({ base: 'DSC_5001', ext: 'MOV' })
    expect(parseOriginalName('FX3-A_9295.MP4')).toEqual({ base: 'FX3-A_9295', ext: 'MP4' })
    expect(parseOriginalName('DSC_4993.MOV')).toEqual({ base: 'DSC_4993', ext: 'MOV' })
    expect(parseOriginalName('DSC00001.JPG')).toEqual({ base: 'DSC00001', ext: 'JPG' })
    expect(parseOriginalName('C9999.MP4')).toEqual({ base: 'C9999', ext: 'MP4' })
  })

  it('takes a hand label placed before the camera number', () => {
    expect(parseOriginalName('Berďa vyhraný gem_C0012.MP4')).toEqual({
      base: 'C0012',
      handLabel: 'Berďa vyhraný gem',
      ext: 'MP4',
    })
    expect(parseOriginalName('Lehy Matchbol_C0197.MP4')).toEqual({
      base: 'C0197',
      handLabel: 'Lehy Matchbol',
      ext: 'MP4',
    })
    expect(parseOriginalName('fans_C0004.MP4')).toEqual({
      base: 'C0004',
      handLabel: 'fans',
      ext: 'MP4',
    })
  })

  it('takes a hand label with spaces after the camera number', () => {
    expect(parseOriginalName('FX3-A_9352_fene fans.MP4')).toEqual({
      base: 'FX3-A_9352',
      handLabel: 'fene fans',
      ext: 'MP4',
    })
  })

  it('does not treat a short number in a label as a camera number', () => {
    expect(parseOriginalName('Gol 2023_C0001.MP4')).toEqual({
      base: 'C0001',
      handLabel: 'Gol 2023',
      ext: 'MP4',
    })
  })

  it('slugifies the whole name when there is no camera number', () => {
    expect(parseOriginalName('Nohy.MP4')).toEqual({ base: 'nohy', ext: 'MP4' })
  })

  it('handles missing extension and dots inside the name', () => {
    expect(parseOriginalName('C0001')).toEqual({ base: 'C0001', ext: '' })
    expect(parseOriginalName('Pan. Novák_C0003.mp4')).toEqual({
      base: 'C0003',
      handLabel: 'Pan. Novák',
      ext: 'mp4',
    })
  })
})

describe('slugify', () => {
  it('strips diacritics, punctuation and surrounding whitespace', () => {
    expect(slugify('Gól Kačor!! ')).toBe('gol-kacor')
  })

  it('maps all Czech diacritics to ascii', () => {
    expect(slugify('ěščřžýáíéůúďťň')).toBe('escrzyaieuudtn')
    expect(slugify('ĚŠČŘŽÝÁÍÉŮÚĎŤŇ')).toBe('escrzyaieuudtn')
  })

  it('limits length without a trailing hyphen', () => {
    const out = slugify('slovo '.repeat(10).trim())
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.endsWith('-')).toBe(false)
    expect(slugify('a'.repeat(60))).toHaveLength(40)
    expect(slugify('abcdefgh ijklmnop', 9)).toBe('abcdefgh')
  })

  it('collapses repeated separators', () => {
    expect(slugify('a  --  b__c')).toBe('a-b-c')
  })
})

describe('buildName', () => {
  it('builds a TOP name', () => {
    expect(
      buildName({ base: 'FX3-A_9347', description: 'sance-kacor', top: true, ext: 'MP4' }),
    ).toBe('FX3-A_9347_TOP_sance-kacor.MP4')
  })

  it('inserts the camera tag after the base', () => {
    expect(
      buildName({ base: 'C0001', description: 'gol', top: false, ext: 'MP4', cameraTag: 'ILCE7M4' }),
    ).toBe('C0001-ILCE7M4_gol.MP4')
    expect(
      buildName({ base: 'C0001', description: 'gol', top: true, ext: 'MP4', cameraTag: 'ILCE7M4' }),
    ).toBe('C0001-ILCE7M4_TOP_gol.MP4')
  })

  it('omits the description segment when empty', () => {
    expect(buildName({ base: 'C0001', description: '', top: false, ext: 'MP4' })).toBe('C0001.MP4')
  })
})

describe('withConflictSuffix', () => {
  it('adds the counter before the extension', () => {
    expect(withConflictSuffix('C0001_gol.MP4', 2)).toBe('C0001_gol (2).MP4')
    expect(withConflictSuffix('C0001_gol.MP4', 10)).toBe('C0001_gol (10).MP4')
  })

  it('appends to names without extension', () => {
    expect(withConflictSuffix('C0001_gol', 3)).toBe('C0001_gol (3)')
  })
})
