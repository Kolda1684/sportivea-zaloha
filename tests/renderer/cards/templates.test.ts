import { describe, expect, it } from 'vitest'
import { templatesProblem } from '../../../src/renderer/cards/templates'

const t = (...names: string[]) => [{ id: 'x', name: 'Fotbal', categories: names.map((name) => ({ name, hint: '' })) }]

describe('templatesProblem', () => {
  it('accepts a normal template', () => {
    expect(templatesProblem(t('Zápas', 'Trénink'))).toBeNull()
  })

  it('rejects the reserved folder names', () => {
    expect(templatesProblem(t('_nezařazeno'))).toContain('používá aplikace sama')
    expect(templatesProblem(t('Zápas', '_ostatni'))).toContain('používá aplikace sama')
    expect(templatesProblem(t(' _NEZAŘAZENO '))).toContain('používá aplikace sama')
  })

  it('rejects empty, slashed and duplicate names', () => {
    expect(templatesProblem(t(''))).toContain('prázdný')
    expect(templatesProblem(t('a/b'))).toContain('lomítka')
    expect(templatesProblem(t('Zápas', 'zápas'))).toContain('dvakrát')
  })
})
