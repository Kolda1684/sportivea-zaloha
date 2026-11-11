import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { looksLikeCard } from '../../core/cards/card'

export type WatchOptions = {
  volumesDir?: string
  isCard?: (root: string) => Promise<boolean>
  /** Quiet time after the last change before volumes are examined. Default 2000. */
  debounceMs?: number
  /** Safety net in case file-system events are missed. Default 5000. */
  pollMs?: number
}

/** The boot volume shows up in /Volumes as a symlink to `/`. */
async function isBootVolume(p: string): Promise<boolean> {
  try {
    if (!(await lstat(p)).isSymbolicLink()) return false
    return (await realpath(p)) === '/'
  } catch {
    return false
  }
}

/**
 * Calls `onCard(root, retryLater)` once for every camera card that appears in `/Volumes`.
 * A card is reported again only after it has been removed and inserted again, or after the listener
 * called `retryLater()` (e.g. the card could not be read yet): then it is reported on the next poll.
 * Returns a function that stops watching.
 */
export function watchVolumes(onCard: (root: string, retryLater: () => void) => void, opts: WatchOptions = {}): () => void {
  const volumesDir = opts.volumesDir ?? '/Volumes'
  const isCard = opts.isCard ?? looksLikeCard
  const debounceMs = opts.debounceMs ?? 2000
  const pollMs = opts.pollMs ?? 5000

  /** Reported volume names; the token tells a stale `retryLater` from a newer report of the same name. */
  const reported = new Map<string, object>()
  let stopped = false
  let scanning = false
  let timer: NodeJS.Timeout | undefined

  const scan = async (): Promise<void> => {
    if (stopped || scanning) return
    scanning = true
    try {
      let names: string[]
      try {
        names = await readdir(volumesDir)
      } catch {
        return
      }
      const present = new Set(names)
      for (const name of [...reported.keys()]) if (!present.has(name)) reported.delete(name)
      for (const name of names.sort()) {
        if (stopped) return
        if (reported.has(name) || name.startsWith('.')) continue
        const root = join(volumesDir, name)
        if (await isBootVolume(root)) continue
        let card = false
        try {
          card = await isCard(root)
        } catch {
          card = false
        }
        if (!card || stopped) continue
        const token = {}
        reported.set(name, token)
        const retryLater = (): void => {
          if (reported.get(name) === token) reported.delete(name)
        }
        try {
          onCard(root, retryLater)
        } catch {
          // a faulty listener must not stop the watcher
        }
      }
    } finally {
      scanning = false
    }
  }

  const schedule = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void scan()
    }, debounceMs)
  }

  let watcher: FSWatcher | undefined
  try {
    watcher = watch(volumesDir, () => schedule())
    watcher.on('error', () => {
      // the poll below keeps working
    })
  } catch {
    // directory missing or not watchable: rely on polling
  }
  const poll = setInterval(schedule, pollMs)
  schedule() // cards that were inserted before the app started

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    clearInterval(poll)
    watcher?.close()
  }
}
