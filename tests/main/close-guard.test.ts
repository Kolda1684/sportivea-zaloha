import { describe, expect, it, vi } from 'vitest'
import {
  CLOSE_WHILE_RUNNING_TEXT,
  CloseGuard,
  KEEP_RUNNING_BUTTON,
  closeWhileRunningText,
  type CloseGuardDeps,
} from '../../src/main/close-guard'

type Fake = {
  deps: CloseGuardDeps
  running: { value: boolean }
  aborts: number
  answers: boolean[]
  asked: number
  finish: () => void
}

/** A run that is active until `finish()`; `confirm` answers from `answers` (true = stop and close). */
function fake(over: Partial<CloseGuardDeps> = {}): Fake {
  const state: Fake = {
    running: { value: true },
    aborts: 0,
    answers: [],
    asked: 0,
    finish: () => undefined,
    deps: undefined as unknown as CloseGuardDeps,
  }
  let resolveIdle: () => void = () => undefined
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve
  })
  state.finish = () => {
    state.running.value = false
    resolveIdle()
  }
  state.deps = {
    isRunning: () => state.running.value,
    abort: () => {
      state.aborts += 1
    },
    idle: () => idle,
    confirm: async () => {
      state.asked += 1
      return state.answers.shift() ?? false
    },
    timeoutMs: 10_000,
    ...over,
  }
  return state
}

const event = (): { preventDefault: ReturnType<typeof vi.fn<() => void>> } => ({ preventDefault: vi.fn<() => void>() })

describe('CloseGuard', () => {
  it('lets the window close when no run is active, without asking', async () => {
    const f = fake()
    f.running.value = false
    const guard = new CloseGuard(f.deps)
    const e = event()
    const proceed = vi.fn<() => void>()
    guard.handle(e, proceed)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(f.asked).toBe(0)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('keeps the run going when the user chooses to continue', async () => {
    const f = fake()
    f.answers.push(false)
    const guard = new CloseGuard(f.deps)
    const e = event()
    const proceed = vi.fn<() => void>()
    guard.handle(e, proceed)
    expect(e.preventDefault).toHaveBeenCalledOnce()
    await guard.settled()
    expect(f.asked).toBe(1)
    expect(f.aborts).toBe(0)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('stops the run, waits until it has finished (manifest written), then closes', async () => {
    const f = fake()
    f.answers.push(true)
    const guard = new CloseGuard(f.deps)
    const proceed = vi.fn<() => void>()
    guard.handle(event(), proceed)
    await vi.waitFor(() => expect(f.aborts).toBe(1))
    // The run is still finishing: not closed yet.
    await Promise.resolve()
    expect(proceed).not.toHaveBeenCalled()
    f.finish()
    await guard.settled()
    expect(proceed).toHaveBeenCalledOnce()
    // The close that follows passes through without asking again, even if a run were still flagged.
    f.running.value = true
    const again = event()
    guard.handle(again, vi.fn<() => void>())
    expect(again.preventDefault).not.toHaveBeenCalled()
    expect(f.asked).toBe(1)
  })

  it('closes after the timeout when the run does not finish in time', async () => {
    vi.useFakeTimers()
    try {
      const f = fake({ timeoutMs: 10_000 })
      f.answers.push(true)
      const guard = new CloseGuard(f.deps)
      const proceed = vi.fn<() => void>()
      guard.handle(event(), proceed)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(proceed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(proceed).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks only once while the dialog is open (close and quit together)', async () => {
    const f = fake()
    let answer: (v: boolean) => void = () => undefined
    f.deps.confirm = () => {
      f.asked += 1
      return new Promise<boolean>((resolve) => {
        answer = resolve
      })
    }
    const guard = new CloseGuard(f.deps)
    const first = event()
    const second = event()
    guard.handle(first, vi.fn<() => void>())
    guard.handle(second, vi.fn<() => void>())
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(f.asked).toBe(1)
    answer(false)
    await guard.settled()
  })

  it('keeps the run going when the dialog itself fails', async () => {
    const f = fake({ confirm: () => Promise.reject(new Error('no window')) })
    const guard = new CloseGuard(f.deps)
    const proceed = vi.fn<() => void>()
    guard.handle(event(), proceed)
    await guard.settled()
    expect(f.aborts).toBe(0)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('guards again after rearm (a new window)', async () => {
    const f = fake()
    f.answers.push(true)
    const guard = new CloseGuard(f.deps)
    guard.handle(event(), vi.fn<() => void>())
    f.finish()
    await guard.settled()
    guard.rearm()
    f.running.value = true
    const e = event()
    guard.handle(e, vi.fn<() => void>())
    expect(e.preventDefault).toHaveBeenCalledOnce()
    await guard.settled()
  })
})

describe('closeWhileRunningText', () => {
  it('download only keeps the download wording', () => {
    expect(closeWhileRunningText(true, false)).toEqual({ message: CLOSE_WHILE_RUNNING_TEXT, keepButton: KEEP_RUNNING_BUTTON })
  })
  it('card only warns that the card is not backed up', () => {
    expect(closeWhileRunningText(false, true)).toEqual({
      message:
        'Záloha karty běží. Když aplikaci zavřeš, záloha se zastaví a karta NENÍ zálohovaná. Po dalším vložení karty vyber stejnou akci: záloha se dokončí a hotové soubory se znovu nenahrají.',
      keepButton: 'Nechat běžet',
    })
  })
  it('both running names both', () => {
    expect(closeWhileRunningText(true, true)).toEqual({
      message:
        'Běží stahování i záloha karty. Když aplikaci zavřeš, obojí se zastaví a karta NENÍ zálohovaná. Stahování pak naváže tam, kde skončilo, kartu dokončíš po dalším vložení se stejnou akcí.',
      keepButton: 'Nechat běžet',
    })
  })
  it('nothing running needs no dialog', () => {
    expect(closeWhileRunningText(false, false)).toBeNull()
  })
})
