export type EventPreset = { eventName: string; isNew: boolean }
export type EventChoice = { mode: 'existing' | 'new'; existing: string; newName: string }

/** Initial choice before the list of events has loaded. */
export function initialChoice(preset: EventPreset | undefined, defaultName: string): EventChoice {
  if (preset && !preset.isNew) return { mode: 'existing', existing: preset.eventName, newName: preset.eventName }
  return { mode: 'new', existing: '', newName: preset?.eventName ?? defaultName }
}

/**
 * Applies the loaded event list to the current choice. A preset event that does not exist (yet), e.g. because the first
 * run failed before its folder was created, becomes a NEW event with exactly that name; another event is never picked silently.
 */
export function reconcileChoice(current: EventChoice, preset: EventPreset | undefined, events: readonly string[]): EventChoice {
  if (current.mode === 'existing') {
    if (events.includes(current.existing)) return current
    if (preset && !preset.isNew && preset.eventName === current.existing) {
      return { mode: 'new', existing: events[0] ?? '', newName: preset.eventName }
    }
    return events.length === 0 ? { ...current, mode: 'new', existing: '' } : { ...current, existing: events[0] ?? '' }
  }
  return { ...current, existing: events.includes(current.existing) ? current.existing : (events[0] ?? '') }
}
