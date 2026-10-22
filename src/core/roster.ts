export type RosterEntry = { number: number; surname: string }

/** `9 Kačor`, `#10 Provod`, `10 - Provod`, `7. Doudera`; lines without number and name are ignored. */
const ROSTER_LINE = /^#?\s*(\d{1,2})\s*[-–—.:)]?\s+(\p{L}[\p{L}\p{M}' .-]*)$/u

export function parseRoster(text: string): RosterEntry[] {
  const entries: RosterEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = ROSTER_LINE.exec(line.trim())
    if (!m) continue
    const surname = (m[2] ?? '').trim()
    if (surname) entries.push({ number: Number(m[1]), surname })
  }
  return entries
}
