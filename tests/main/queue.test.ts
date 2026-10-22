import { describe, expect, it } from 'vitest'
import { JobQueue } from '../../src/main/queue'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('JobQueue', () => {
  it('runs jobs strictly one at a time, in order', async () => {
    const q = new JobQueue()
    const log: string[] = []
    let running = 0
    let maxRunning = 0
    const job = (name: string, ms: number) => async (): Promise<void> => {
      running++
      maxRunning = Math.max(maxRunning, running)
      log.push(`start ${name}`)
      await tick(ms)
      log.push(`end ${name}`)
      running--
    }
    q.enqueue(job('a', 30))
    q.enqueue(job('b', 5))
    q.enqueue(job('c', 15))
    expect(q.pending).toBe(3)
    await q.idle()
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(maxRunning).toBe(1)
    expect(q.pending).toBe(0)
  })

  it('keeps going after a failing job and reports the error', async () => {
    const errors: unknown[] = []
    const q = new JobQueue((e) => errors.push(e))
    const ran: string[] = []
    q.enqueue(async () => {
      throw new Error('boom')
    })
    q.enqueue(async () => {
      ran.push('second')
    })
    await q.idle()
    expect(ran).toEqual(['second'])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
  })

  it('treats a synchronously throwing job as a failure, not a crash', async () => {
    const errors: unknown[] = []
    const q = new JobQueue((e) => errors.push(e))
    q.enqueue((() => {
      throw new Error('sync')
    }) as () => Promise<void>)
    q.enqueue(async () => {})
    await q.idle()
    expect(errors).toHaveLength(1)
    expect(q.pending).toBe(0)
  })

  it('accepts jobs enqueued while another is running', async () => {
    const q = new JobQueue()
    const order: number[] = []
    q.enqueue(async () => {
      await tick(10)
      order.push(1)
      q.enqueue(async () => {
        order.push(3)
      })
    })
    q.enqueue(async () => {
      order.push(2)
    })
    await q.idle()
    expect(order).toEqual([1, 2, 3])
  })
})
