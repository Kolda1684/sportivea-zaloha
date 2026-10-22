export type RecentStatus = 'ok' | 'card_removed' | 'verify_failed' | 'aborted' | 'failed'
export type RecentRun = { id: string; eventName: string; finishedAt: number; status: RecentStatus }

const KEY = 'trideni.recent'
const MAX = 8
const STATUSES: ReadonlySet<string> = new Set(['ok', 'card_removed', 'verify_failed', 'aborted', 'failed'])

function isRecent(v: unknown): v is RecentRun {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r['id'] === 'string' && typeof r['eventName'] === 'string' && typeof r['finishedAt'] === 'number' && typeof r['status'] === 'string' && STATUSES.has(r['status'])
}

/** Recent runs live in this browser profile only (a convenience); every access tolerates missing storage. */
export function loadRecent(): RecentRun[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, MAX) : []
  } catch {
    return []
  }
}

export function addRecent(list: RecentRun[], run: RecentRun): RecentRun[] {
  const next = [run, ...list.filter((r) => r.id !== run.id)].slice(0, MAX)
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // not persisted; still shown for this session
  }
  return next
}
