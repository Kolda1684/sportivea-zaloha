import { describe, expect, it } from 'vitest'
import { initialChoice, reconcileChoice } from '../../src/renderer/eventChoice'

const DEFAULT = '2026-10-19 '

describe('initialChoice', () => {
  it('is a new event with the default name without a preset', () => {
    expect(initialChoice(undefined, DEFAULT)).toEqual({ mode: 'new', existing: '', newName: DEFAULT })
  })

  it('selects the preset event as existing', () => {
    expect(initialChoice({ eventName: 'Istanbul', isNew: false }, DEFAULT)).toMatchObject({ mode: 'existing', existing: 'Istanbul' })
  })

  it('uses the preset name for a new event', () => {
    expect(initialChoice({ eventName: 'Istanbul', isNew: true }, DEFAULT)).toMatchObject({ mode: 'new', newName: 'Istanbul' })
  })
})

describe('reconcileChoice', () => {
  const preset = { eventName: 'Istanbul', isNew: false }

  it('keeps an existing preset event that is in the list', () => {
    const c = reconcileChoice(initialChoice(preset, DEFAULT), preset, ['Jiná akce', 'Istanbul'])
    expect(c).toMatchObject({ mode: 'existing', existing: 'Istanbul' })
  })

  it('turns a preset event that does not exist into a new event with that exact name (empty list)', () => {
    const c = reconcileChoice(initialChoice(preset, DEFAULT), preset, [])
    expect(c).toMatchObject({ mode: 'new', newName: 'Istanbul' })
  })

  it('never switches silently to another event when the preset is missing from a non-empty list', () => {
    const c = reconcileChoice(initialChoice(preset, DEFAULT), preset, ['Jiná akce'])
    expect(c.mode).toBe('new')
    expect(c.newName).toBe('Istanbul')
  })

  it('without a preset: empty list falls back to a new event, otherwise the first event is the select value', () => {
    const start = initialChoice(undefined, DEFAULT)
    expect(reconcileChoice(start, undefined, []).mode).toBe('new')
    expect(reconcileChoice(start, undefined, ['A', 'B'])).toMatchObject({ mode: 'new', existing: 'A', newName: DEFAULT })
  })

  it('does not touch what the user typed for a new event', () => {
    const c = reconcileChoice({ mode: 'new', existing: '', newName: 'Moje akce' }, undefined, ['A'])
    expect(c.newName).toBe('Moje akce')
    expect(c.mode).toBe('new')
  })
})
