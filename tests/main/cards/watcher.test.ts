import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { looksLikeCard } from '../../../src/core/cards/card'
import { watchVolumes } from '../../../src/main/cards/watcher'

let volumes: string
let stops: Array<() => void> = []

beforeEach(async () => {
  volumes = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-volumes-'))
})
afterEach(async () => {
  for (const stop of stops) stop()
  stops = []
  await fs.rm(volumes, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await wait(20)
}

function start(onCard: Parameters<typeof watchVolumes>[0], isCard?: (root: string) => Promise<boolean>) {
  const stop = watchVolumes(onCard, {
    volumesDir: volumes,
    debounceMs: 60,
    pollMs: 200,
    ...(isCard ? { isCard } : {}),
  })
  stops.push(stop)
  return stop
}

describe('watchVolumes', () => {
  it('reports a new card once after the debounce', async () => {
    const cards: string[] = []
    start((r) => cards.push(r))
    await wait(30)
    await fs.mkdir(path.join(volumes, 'CARD1', 'PRIVATE', 'M4ROOT', 'CLIP'), { recursive: true })
    await waitFor(() => cards.length > 0)
    await wait(500) // later polls must not report it again
    expect(cards).toEqual([path.join(volumes, 'CARD1')])
  })

  it('does not report a volume that is not a card', async () => {
    const cards: string[] = []
    const checked: string[] = []
    start(
      (r) => cards.push(r),
      async (r) => {
        checked.push(r)
        return false
      },
    )
    await fs.mkdir(path.join(volumes, 'NOTCARD'))
    await waitFor(() => checked.length > 0)
    await wait(150)
    expect(checked.length).toBeGreaterThan(0)
    expect(cards).toEqual([])
  })

  it('does not report before the debounce has elapsed', async () => {
    const cards: string[] = []
    const stop = watchVolumes((r) => cards.push(r), { volumesDir: volumes, debounceMs: 400, pollMs: 5000 })
    stops.push(stop)
    await fs.mkdir(path.join(volumes, 'CARD1', 'DCIM'), { recursive: true })
    await wait(150)
    expect(cards).toEqual([])
    await waitFor(() => cards.length > 0)
    expect(cards).toHaveLength(1)
  })

  it('reports a card that was already mounted when watching started', async () => {
    await fs.mkdir(path.join(volumes, 'CARD0', 'DCIM'), { recursive: true })
    const cards: string[] = []
    start((r) => cards.push(r))
    await waitFor(() => cards.length > 0)
    expect(cards).toEqual([path.join(volumes, 'CARD0')])
  })

  it('reports a card again after it was removed and re-inserted', async () => {
    const cards: string[] = []
    start((r) => cards.push(r))
    const card = path.join(volumes, 'CARD1')
    await fs.mkdir(path.join(card, 'DCIM'), { recursive: true })
    await waitFor(() => cards.length === 1)
    await fs.rm(card, { recursive: true })
    await wait(500)
    await fs.mkdir(path.join(card, 'DCIM'), { recursive: true })
    await waitFor(() => cards.length === 2)
    expect(cards).toEqual([card, card])
  })

  it('retries a volume that was not readable as a card yet', async () => {
    const cards: string[] = []
    let ready = false
    start(
      (r) => cards.push(r),
      async () => ready,
    )
    await fs.mkdir(path.join(volumes, 'LATE'))
    await wait(300)
    expect(cards).toEqual([])
    ready = true
    await waitFor(() => cards.length > 0)
    expect(cards).toEqual([path.join(volumes, 'LATE')])
  })

  it('reports a card again on the next poll when the listener could not use it (retryLater)', async () => {
    const cards: string[] = []
    let failures = 2
    start((root, retryLater) => {
      cards.push(root)
      if (failures > 0) {
        failures--
        // e.g. describeCard returned null: asynchronously, like the real listener
        setTimeout(retryLater, 10)
      }
    })
    await fs.mkdir(path.join(volumes, 'CARD1', 'DCIM'), { recursive: true })
    await waitFor(() => cards.length === 3)
    await wait(500) // accepted now: not reported again
    expect(cards).toEqual([path.join(volumes, 'CARD1'), path.join(volumes, 'CARD1'), path.join(volumes, 'CARD1')])
  })

  it('ignores the boot volume (symlink to /)', async () => {
    await fs.symlink('/', path.join(volumes, 'Macintosh HD'))
    const cards: string[] = []
    start(
      (r) => cards.push(r),
      async () => true,
    )
    await wait(500)
    expect(cards).toEqual([])
  })

  it('stops reporting after the returned stop function is called', async () => {
    const cards: string[] = []
    const stop = start((r) => cards.push(r))
    stop()
    await fs.mkdir(path.join(volumes, 'CARD1', 'DCIM'), { recursive: true })
    await wait(500)
    expect(cards).toEqual([])
  })

  it('survives a missing volumes directory', async () => {
    const stop = watchVolumes(() => {}, { volumesDir: path.join(volumes, 'nope'), debounceMs: 20, pollMs: 50 })
    stops.push(stop)
    await wait(150)
    expect(typeof stop).toBe('function')
  })

  it('uses looksLikeCard by default', async () => {
    const cards: string[] = []
    start((r) => cards.push(r))
    await fs.mkdir(path.join(volumes, 'PLAIN'))
    await fs.mkdir(path.join(volumes, 'SONY', 'PRIVATE', 'M4ROOT', 'CLIP'), { recursive: true })
    await waitFor(() => cards.length > 0)
    await wait(300)
    expect(cards).toEqual([path.join(volumes, 'SONY')])
    expect(await looksLikeCard(path.join(volumes, 'PLAIN'))).toBe(false)
  })
})
