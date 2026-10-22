import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type JournalEntry = {
  sha256: string
  size: number
  originalRelPath: string
  eventDir: string
  destPath: string
  at: string
}

function isEntry(v: unknown): v is JournalEntry {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['sha256'] === 'string' &&
    typeof o['size'] === 'number' &&
    typeof o['originalRelPath'] === 'string' &&
    typeof o['eventDir'] === 'string' &&
    typeof o['destPath'] === 'string' &&
    typeof o['at'] === 'string'
  )
}

const byHash = (eventDir: string, sha256: string, size: number): string =>
  JSON.stringify([eventDir, sha256, size])
const byOriginal = (eventDir: string, rel: string, size: number): string =>
  JSON.stringify([eventDir, rel, size])

/**
 * Append-only JSON Lines record of what was copied. A truncated last line (crash while
 * appending) is ignored on load; the next append starts on a fresh line so it is not glued
 * to the damaged tail. Lines are never rewritten or removed.
 */
export class Journal {
  private readonly hashIndex = new Map<string, JournalEntry>()
  private readonly originalIndex = new Map<string, JournalEntry>()
  private needsLeadingNewline: boolean
  private queue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly file: string,
    entries: JournalEntry[],
    endsCleanly: boolean,
  ) {
    this.needsLeadingNewline = !endsCleanly
    for (const e of entries) this.index(e)
  }

  static async load(file: string): Promise<Journal> {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Journal(file, [], true)
      throw err
    }
    const entries: JournalEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isEntry(parsed)) entries.push(parsed)
      } catch {
        // truncated or damaged line: skip
      }
    }
    return new Journal(file, entries, text === '' || text.endsWith('\n'))
  }

  find(eventDir: string, sha256: string, size: number): JournalEntry | undefined {
    return this.hashIndex.get(byHash(eventDir, sha256, size))
  }

  findByOriginal(eventDir: string, originalRelPath: string, size: number): JournalEntry | undefined {
    return this.originalIndex.get(byOriginal(eventDir, originalRelPath, size))
  }

  append(e: JournalEntry): Promise<void> {
    const run = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const line = `${this.needsLeadingNewline ? '\n' : ''}${JSON.stringify(e)}\n`
      await fs.appendFile(this.file, line)
      this.needsLeadingNewline = false
      this.index(e)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private index(e: JournalEntry): void {
    const h = byHash(e.eventDir, e.sha256, e.size)
    if (!this.hashIndex.has(h)) this.hashIndex.set(h, e)
    const o = byOriginal(e.eventDir, e.originalRelPath, e.size)
    if (!this.originalIndex.has(o)) this.originalIndex.set(o, e)
  }
}
