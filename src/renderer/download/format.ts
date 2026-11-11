const NBSP = ' '
const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const

function czNumber(value: number, decimals: number): string {
  return value.toFixed(decimals).replace('.', ',')
}

/** Three significant digits: `1,02`, `85,3`, `210`; no trailing zeros. */
function significant(value: number): { text: string; rounded: number } {
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  const rounded = Number(value.toFixed(decimals))
  const text = czNumber(rounded, decimals)
  return { text: decimals > 0 ? text.replace(/,?0+$/, '') : text, rounded }
}

/** `1,02 TB`, `85,3 MB`, `210 GB`: decimal units (like Finder), decimal comma. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let unit = 0
  let value = bytes
  while (unit < UNITS.length - 1 && value >= 1000) {
    value /= 1000
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  let result = significant(value)
  if (result.rounded >= 1000 && unit < UNITS.length - 1) {
    // 999 999 B must read `1 MB`, not `1000 kB`
    value /= 1000
    unit++
    result = significant(value)
  }
  return `${result.text} ${UNITS[unit]}`
}

/** `85,3 MB/s` */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** `2 h 15 min`, `2 min 5 s`, `40 s`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s'
  const total = Math.round(seconds)
  if (total < 60) return `${total} s`
  if (total < 3600) {
    const m = Math.floor(total / 60)
    const s = total % 60
    return s === 0 ? `${m} min` : `${m} min ${s} s`
  }
  const minutes = Math.round(total / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Seconds left at the given speed, rounded up; `null` when it cannot be estimated. */
export function eta(doneBytes: number, totalBytes: number, bytesPerSec: number): number | null {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return null
  const remaining = totalBytes - doneBytes
  if (remaining <= 0) return 0
  return Math.ceil(remaining / bytesPerSec)
}

/** `1 234`: thousands separated by a non-breaking space. */
export function formatCount(n: number): string {
  const whole = Math.max(0, Math.round(Number.isFinite(n) ? n : 0))
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** Czech plural: 1 soubor, 2-4 soubory, 0 and 5+ souborů. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  return n >= 2 && n <= 4 ? few : many
}

/** `20. 10. 2026` (local date), or `null` for a missing or invalid timestamp. */
export function formatDate(iso: string | null): string | null {
  if (iso === null) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`
}

/** Last segment of a `/`-separated path. */
export function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}
