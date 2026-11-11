import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'

/**
 * Append-only JSON Lines record of what was downloaded and verified, kept at
 * `<destRoot>/.stahovani/journal.jsonl`. Lines are never rewritten or removed. A damaged line (crash while
 * appending) is skipped on load and the next append starts on a fresh line, so it never swallows a record.
 * The journal path is never followed through a symlink.
 */

/** Relative, no empty segments, no `.` / `..`, no NUL: a journal line must never point outside the chosen directory. */
const isSafeRelPath = (p: string): boolean =>
  !p.startsWith('/') && !p.includes('\0') && p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')

const JournalRecordSchema = z.object({
  fileId: z.string().min(1),
  /** Relative to the chosen directory; starts with `rootName/`. */
  localRelPath: z.string().refine(isSafeRelPath, 'unsafe relative path'),
  size: z.number().int().nonnegative(),
  md5: z.string().nullable(),
  modifiedTime: z.string(),
  kind: z.enum(['file', 'export']),
  /** `mtimeMs` of the final file right after it was written and verified. */
  localMtimeMs: z.number().finite(),
  at: z.string().min(1),
})

export type JournalRecord = z.infer<typeof JournalRecordSchema>

const JOURNAL_DIR = '.stahovani'
const JOURNAL_FILE = 'journal.jsonl'
const NEWLINE = 0x0a
const APPEND_FLAGS = fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW

const NOT_REGULAR_MESSAGE =
  'Žurnál stahování není běžný soubor, proto ho nepoužiju. Zkontroluj složku .stahovani v cíli.'

/** The journal or its directory is not what we wrote (symlink, directory, ...). Message is Czech, UI-ready. */
export class JournalFormatError extends Error {
  constructor() {
    super(NOT_REGULAR_MESSAGE)
    this.name = 'JournalFormatError'
  }
}

export function journalPath(destRoot: string): string {
  return path.join(destRoot, JOURNAL_DIR, JOURNAL_FILE)
}

const isErrno = (err: unknown, ...codes: string[]): boolean =>
  typeof err === 'object' && err !== null && codes.includes((err as NodeJS.ErrnoException).code ?? '')

/** `true` when `.stahovani` exists as a real directory, `false` when missing; throws if it is anything else. */
async function journalDirExists(destRoot: string): Promise<boolean> {
  try {
    const st = await fs.lstat(path.join(destRoot, JOURNAL_DIR))
    if (!st.isDirectory()) throw new JournalFormatError()
    return true
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false
    throw err
  }
}

async function ensureJournalDir(destRoot: string): Promise<void> {
  if (await journalDirExists(destRoot)) return
  try {
    // Non-recursive on purpose: if `destRoot` is missing this fails with ENOENT instead of creating it.
    await fs.mkdir(path.join(destRoot, JOURNAL_DIR))
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err
    // Created by someone else meanwhile: fine only if it is a real directory.
    if (!(await journalDirExists(destRoot))) throw err
  }
}

export async function appendRecord(destRoot: string, r: JournalRecord): Promise<void> {
  const record = JournalRecordSchema.parse(r)
  await ensureJournalDir(destRoot)
  let handle: fs.FileHandle
  try {
    handle = await fs.open(journalPath(destRoot), APPEND_FLAGS, 0o644)
  } catch (err) {
    if (isErrno(err, 'ELOOP', 'EISDIR')) throw new JournalFormatError()
    throw err
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new JournalFormatError()
    let prefix = ''
    if (st.size > 0) {
      const last = Buffer.alloc(1)
      const { bytesRead } = await handle.read(last, 0, 1, st.size - 1)
      if (bytesRead === 1 && last[0] !== NEWLINE) prefix = '\n'
    }
    await handle.writeFile(`${prefix}${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Last record per `fileId` wins. A missing journal gives an empty map; damaged or invalid lines are skipped. */
export async function loadJournal(destRoot: string): Promise<Map<string, JournalRecord>> {
  const records = new Map<string, JournalRecord>()
  if (!(await journalDirExists(destRoot))) return records
  const file = journalPath(destRoot)
  let text: string
  try {
    if (!(await fs.lstat(file)).isFile()) throw new JournalFormatError()
    const handle = await fs.open(file, READ_FLAGS)
    try {
      if (!(await handle.stat()).isFile()) throw new JournalFormatError()
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return records
    if (isErrno(err, 'ELOOP', 'EISDIR')) throw new JournalFormatError()
    throw err
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const result = JournalRecordSchema.safeParse(parsed)
    if (result.success) records.set(result.data.fileId, result.data)
  }
  return records
}
