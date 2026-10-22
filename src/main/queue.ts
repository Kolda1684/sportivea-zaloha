/** Runs jobs strictly one at a time, in the order they were enqueued. A failing job never stops the queue. */
export class JobQueue {
  private tail: Promise<void> = Promise.resolve()
  private count = 0

  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  /** Jobs waiting plus the one currently running. */
  get pending(): number {
    return this.count
  }

  enqueue(job: () => Promise<void>): void {
    this.count++
    this.tail = this.tail.then(async () => {
      try {
        await job()
      } catch (error) {
        try {
          this.onError(error)
        } catch {
          // the error listener must not break the queue either
        }
      } finally {
        this.count--
      }
    })
  }

  /** Resolves when every job enqueued so far (and any enqueued meanwhile) has finished. */
  async idle(): Promise<void> {
    let seen: Promise<void>
    do {
      seen = this.tail
      await seen
    } while (seen !== this.tail)
  }
}
