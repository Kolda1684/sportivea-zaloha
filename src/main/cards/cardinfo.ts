import { lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import { scanCard } from '../../core/cards/card'
import type { CardDetected } from '../../shared/cards-ipc'

/**
 * Cheap summary of a card for the "card detected" screen: scan + file times only, no probing of clips.
 * Returns null when the card cannot be read (e.g. it was pulled out meanwhile).
 */
export async function describeCard(root: string): Promise<CardDetected | null> {
  try {
    const files = await scanCard(root)
    const videos = files.filter((f) => f.kind === 'video')
    let first: number | null = null
    let last: number | null = null
    for (const v of videos) {
      const t = (await lstat(v.absPath)).mtimeMs
      if (first === null || t < first) first = t
      if (last === null || t > last) last = t
    }
    return {
      root,
      volumeName: basename(root) || root,
      videos: videos.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      firstDate: first === null ? null : new Date(first).toISOString(),
      lastDate: last === null ? null : new Date(last).toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * Watcher listener: describes the card and hands it to `onCard`. When the card cannot be described (null or
 * an error), `retryLater` un-marks the volume so that the watcher examines it again on its next poll.
 */
export function cardListener(
  onCard: (root: string, card: CardDetected) => void,
  describe: (root: string) => Promise<CardDetected | null> = describeCard,
): (root: string, retryLater: () => void) => void {
  return (root, retryLater) => {
    void describe(root).then((card) => {
      if (!card) return retryLater()
      onCard(root, card)
    }, retryLater)
  }
}
