import { expect, it } from 'vitest'
import { IPC as CARDS } from '../../src/shared/cards-ipc'
import { IPC as DOWNLOAD } from '../../src/shared/download-ipc'

it('channel names are unique across modes', () => {
  const all = [...Object.values(DOWNLOAD), ...Object.values(CARDS)]
  expect(new Set(all).size).toBe(all.length)
  expect(Object.values(DOWNLOAD).every((c) => c.startsWith('download.'))).toBe(true)
  expect(Object.values(CARDS).every((c) => c.startsWith('cards.'))).toBe(true)
})
