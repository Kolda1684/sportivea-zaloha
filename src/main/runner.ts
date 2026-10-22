import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'
import { ClaudeClassifier, type Classifier } from '../core/classifier'
import { makeSpaceWaiter } from '../core/diskspace'
import { Journal } from '../core/journal'
import { runCard, type RunEvent, type RunSummary } from '../core/pipeline'
import { parseRoster } from '../core/roster'
import type { Result, RunEventPayload, RunStartRequest, Settings } from '../shared/ipc-types'
import { JobQueue } from './queue'

export const FINAL_OK_MESSAGE =
  'Zapsáno a ověřeno. Kartu můžeš vytáhnout. Drive dokončuje upload, kartu formátuj až po jeho dokončení (ikona Drive v liště).'
export const NOT_BACKED_UP = 'Karta ještě NENÍ zálohovaná'
export const TOOLS_MISSING = 'Chybí nástroj ffprobe/ffmpeg — aplikace je poškozená, kontaktuj Jana.'

const requestSchema = z.object({
  cardRoot: z.string().min(1).max(4096),
  eventName: z.string().min(1).max(200),
  isNew: z.boolean(),
  templateId: z.string().min(1).max(100),
  rosterText: z.string().max(20_000),
  sort: z.boolean(),
})

export type Notice = { title: string; body: string }

export type RunnerDeps = {
  getSettings(): Promise<Settings>
  getApiKey(): Promise<string | null>
  journalFile: string
  send(payload: RunEventPayload): void
  notify(notice: Notice): void
  /** Defaults to the real Claude classifier. */
  makeClassifier?(apiKey: string, model: string): Classifier
  /** Defaults to the real pipeline; injectable for tests. */
  run?: typeof runCard
  /** Result of the startup check of ffprobe/ffmpeg; runs are refused when false. Default: assumed ok. */
  toolsOk?(): Promise<boolean>
}

/** Notification text for a finished (or failed) run. */
export function noticeFor(summary: RunSummary): Notice {
  switch (summary.status) {
    case 'ok':
      return { title: 'Třídění karet', body: FINAL_OK_MESSAGE }
    case 'card_removed':
      return { title: NOT_BACKED_UP, body: 'Karta byla odpojena během zálohování. Zasuň ji znovu a spusť zálohu znovu, naváže se.' }
    case 'aborted':
      return { title: NOT_BACKED_UP, body: 'Záloha byla přerušena. Zasuň kartu znovu a spusť zálohu znovu.' }
    case 'verify_failed':
      return { title: NOT_BACKED_UP, body: 'Některé soubory se nepodařilo zapsat nebo ověřit. Podívej se do aplikace.' }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isPlainFolderName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name) && !name.startsWith('.') && name === name.trim()
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function realOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined
}

export class Runner {
  private readonly queue: JobQueue
  /** Cards the app itself found or the user picked; `run:start` accepts only these. */
  private readonly knownCards = new Set<string>()
  /** Cards queued or running right now. */
  private readonly active = new Set<string>()

  constructor(private readonly deps: RunnerDeps) {
    this.queue = new JobQueue()
  }

  registerCard(root: string): void {
    this.knownCards.add(path.resolve(root))
  }

  get pending(): number {
    return this.queue.pending
  }

  /** Validates, creates the event folder (new events) and queues the run. Never throws. */
  async start(raw: unknown): Promise<Result> {
    try {
      return await this.prepareAndEnqueue(raw)
    } catch (e) {
      return { ok: false, error: `Zálohu se nepodařilo spustit: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  private async prepareAndEnqueue(raw: unknown): Promise<Result> {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Neplatný požadavek na zálohu.' }
    const req: RunStartRequest = parsed.data
    if (this.deps.toolsOk && !(await this.deps.toolsOk())) return { ok: false, error: TOOLS_MISSING }
    const eventName = req.eventName.trim()
    const cardRoot = path.resolve(req.cardRoot)

    const settings = await this.deps.getSettings()
    if (settings.rootDir === null) return { ok: false, error: 'Nejdřív vyber složku na Disku, kam se mají akce ukládat.' }
    const rootDir = settings.rootDir
    if (!path.isAbsolute(rootDir) || !(await isDirectory(rootDir))) {
      return { ok: false, error: 'Složka pro akce není dostupná. Je Google Drive připojený?' }
    }
    // Without sorting no key is needed: everything is backed up to _nezařazeno.
    let apiKey: string | null = null
    if (req.sort) {
      apiKey = await this.deps.getApiKey()
      if (apiKey === null || apiKey === '') return { ok: false, error: 'Chybí klíč ke Claude. Zadej ho v nastavení.' }
    }

    const template = settings.templates.find((t) => t.id === req.templateId)
    if (!template) return { ok: false, error: 'Vybraná šablona kategorií neexistuje.' }

    if (!this.knownCards.has(cardRoot)) return { ok: false, error: 'Tuhle kartu aplikace nezná. Zasuň ji znovu nebo vyber složku ručně.' }
    if (!(await isDirectory(cardRoot))) return { ok: false, error: 'Karta není dostupná. Je zasunutá?' }
    if (this.active.has(cardRoot)) return { ok: false, error: 'Tahle karta se už zálohuje nebo čeká ve frontě.' }

    this.active.add(cardRoot) // reserved synchronously so that a double click cannot start the card twice
    let queued = false
    try {
      const result = await this.prepareFolderAndEnqueue(cardRoot, eventName, req, settings, rootDir, template, apiKey)
      queued = result.ok
      return result
    } finally {
      if (!queued) this.active.delete(cardRoot)
    }
  }

  private async prepareFolderAndEnqueue(
    cardRoot: string,
    eventName: string,
    req: RunStartRequest,
    settings: Settings,
    rootDir: string,
    template: Settings['templates'][number],
    apiKey: string | null,
  ): Promise<Result> {
    if (!isPlainFolderName(eventName)) return { ok: false, error: 'Název akce nesmí být prázdný ani obsahovat lomítka.' }

    const rootReal = await realOr(rootDir)
    const cardReal = await realOr(cardRoot)
    if (isInside(rootReal, cardReal) || isInside(cardReal, rootReal)) {
      return { ok: false, error: 'Karta a složka pro akce se překrývají. Vyber jinou kartu nebo složku.' }
    }

    const eventDir = path.join(rootDir, eventName)
    if (req.isNew) {
      try {
        await fs.mkdir(eventDir) // not recursive: the root folder must already exist (a vanished Drive is never recreated)
      } catch (e) {
        if (errCode(e) === 'EEXIST') return { ok: false, error: 'Akce s tímhle názvem už existuje. Vyber ji ze seznamu, nebo zvol jiný název.' }
        throw e
      }
    } else {
      // lstat, like the pipeline: a symlinked event folder would be treated there as a vanished destination
      let st: Awaited<ReturnType<typeof fs.lstat>>
      try {
        st = await fs.lstat(eventDir)
      } catch {
        return { ok: false, error: 'Složka vybrané akce neexistuje.' }
      }
      if (st.isSymbolicLink()) return { ok: false, error: 'Složka akce je jen odkaz (symbolický odkaz). Vyber skutečnou složku akce.' }
      if (!st.isDirectory()) return { ok: false, error: 'Vybraná akce není složka.' }
    }

    const position = this.queue.pending
    this.deps.send({ cardRoot, event: { type: 'queued', position } })
    this.queue.enqueue(() => this.job(cardRoot, eventDir, template, req.rosterText, settings, apiKey))
    return { ok: true }
  }

  private async job(
    cardRoot: string,
    eventDir: string,
    template: Settings['templates'][number],
    rosterText: string,
    settings: Settings,
    apiKey: string | null,
  ): Promise<void> {
    const send = (event: RunEventPayload['event']): void => {
      try {
        this.deps.send({ cardRoot, event })
      } catch {
        // a closed window must not interrupt the backup
      }
    }
    try {
      send({ type: 'started' })
      const journal = await Journal.load(this.deps.journalFile)
      const makeClassifier = this.deps.makeClassifier ?? ((key: string, model: string) => new ClaudeClassifier({ apiKey: key, model }))
      const classifier = apiKey === null ? null : makeClassifier(apiKey, settings.model)
      const forward = (event: RunEvent): void => send(event)
      const summary = await (this.deps.run ?? runCard)(
        {
          cardRoot,
          eventDir,
          template,
          roster: parseRoster(rosterText),
          classifier,
          journal,
          markerOpts: { lumaThreshold: settings.lumaThreshold },
          waitForSpace: makeSpaceWaiter(eventDir, {
            onWaiting: (needed, free) => forward({ type: 'waiting_space', needed, free }),
          }),
        },
        forward,
      )
      this.notifySafe(noticeFor(summary))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      send({ type: 'failed', message })
      this.notifySafe({ title: NOT_BACKED_UP, body: `Záloha selhala: ${message}` })
    } finally {
      this.active.delete(cardRoot)
    }
  }

  private notifySafe(notice: Notice): void {
    try {
      this.deps.notify(notice)
    } catch {
      // notifications are a convenience only
    }
  }

  /** Resolves when everything queued so far has finished (used by tests). */
  idle(): Promise<void> {
    return this.queue.idle()
  }
}

/** Subfolders of `rootDir`, most recently modified first. */
export async function listEvents(rootDir: string | null): Promise<string[]> {
  if (rootDir === null) return []
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true })
    const dirs: Array<{ name: string; mtime: number }> = []
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      try {
        dirs.push({ name: e.name, mtime: (await fs.stat(path.join(rootDir, e.name))).mtimeMs })
      } catch {
        dirs.push({ name: e.name, mtime: 0 })
      }
    }
    dirs.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name, 'cs'))
    return dirs.map((d) => d.name)
  } catch {
    return []
  }
}
