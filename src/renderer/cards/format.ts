const NBSP = ' '
const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const

function czNumber(value: number, decimals: number): string {
  return value.toFixed(decimals).replace('.', ',')
}

/** `1,5 kB`, `12,3 GB`: decimal units (like Finder), decimal comma, no trailing `,0`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let unit = 0
  let value = bytes
  while (unit < UNITS.length - 1 && value >= 1000) {
    value /= 1000
    unit++
  }
  let decimals = unit === 0 || value >= 100 ? 0 : 1
  let rounded = Number(value.toFixed(decimals))
  if (rounded >= 1000 && unit < UNITS.length - 1) {
    // 999 999 B must read `1 MB`, not `1000 kB`
    value /= 1000
    unit++
    decimals = value >= 100 ? 0 : 1
    rounded = Number(value.toFixed(decimals))
  }
  const text = czNumber(rounded, decimals).replace(/,0$/, '')
  return `${text} ${UNITS[unit]}`
}

/** `2,35 Kč` below 100 Kč, whole crowns with a non-breaking space between thousands from 100 up. */
export function formatCzk(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return `0${NBSP}Kč`
  const cents = Math.round(amount * 100) / 100
  if (cents < 100) {
    return `${czNumber(cents, 2).replace(/,00$/, '')}${NBSP}Kč`
  }
  const whole = Math.round(amount).toString()
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  return `${grouped}${NBSP}Kč`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `2026-10-20 ` from the local date of the first clip; the user types the rest of the event name. */
export function defaultEventName(firstDate: Date): string {
  return `${firstDate.getFullYear()}-${pad2(firstDate.getMonth() + 1)}-${pad2(firstDate.getDate())} `
}

function czDate(d: Date): string {
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`
}

function parseDate(iso: string | null): Date | null {
  if (iso === null) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** `20. 10. 2026` or `20. 10. 2026 – 21. 10. 2026`; `neznámé` when the card has no usable dates. */
export function formatDateRange(first: string | null, last: string | null): string {
  const a = parseDate(first)
  const b = parseDate(last)
  if (a === null && b === null) return 'neznámé'
  const from = a ?? b
  const to = b ?? a
  if (from === null || to === null) return 'neznámé'
  const x = czDate(from)
  const y = czDate(to)
  return x === y ? x : `${x} – ${y}`
}

/** Last segment of a `/`-separated path. */
export function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/** A Google Drive for desktop path shown from the drive root ("Google Disk › Sdílené disky › …"); other paths unchanged. */
export function drivePath(p: string): string {
  const m = /^\/Users\/[^/]+\/Library\/CloudStorage\/GoogleDrive-[^/]+\/(.+)$/.exec(p)
  if (!m || m[1] === undefined) return p
  return ['Google Disk', ...m[1].split('/').filter((s) => s !== '')].join(' › ')
}

/** Czech plural: 1 klip, 2-4 klipy, 0 and 5+ klipů. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  return n >= 2 && n <= 4 ? few : many
}

/** Done-screen line for clips whose classification failed (they are in `_nezařazeno`, the backup itself is complete). */
export function classifyFailureMessage(n: number): string {
  return `${n} ${plural(n, 'klip', 'klipy', 'klipů')} se nepodařilo roztřídit — ${plural(n, 'je', 'jsou', 'jsou')} ve složce _nezařazeno`
}
