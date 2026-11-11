/**
 * Classification eval: runs the real classifier on clips from a reference set and compares with the
 * folders Jan chose by hand. Usage: `npm run eval -- --help`.
 * The camera card is only read (directory listing, ffprobe/ffmpeg input).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ClaudeClassifier } from '../src/core/cards/classifier'
import { contactSheet } from '../src/core/cards/frames'
import { probeClip } from '../src/core/cards/probe'
import { DEFAULT_TEMPLATES } from '../src/core/cards/templates'
import {
  EVAL_SETS,
  EvalUsageError,
  USAGE,
  estimateRun,
  formatSummary,
  indexFilesByBasename,
  matchReference,
  parseEvalArgs,
  parseReferenceCsv,
  runEval,
  writeResultsCsv,
  type ReferenceRow,
} from './eval-lib'

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

function listNames(rows: ReferenceRow[], max = 5): string {
  const shown = rows.slice(0, max).map((r) => r.original).join(', ')
  return rows.length > max ? `${shown}, ... (+${rows.length - max})` : shown
}

async function main(): Promise<void> {
  let args
  try {
    args = parseEvalArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof EvalUsageError) fail(`${err.message}\n\n${USAGE}`, 2)
    throw err
  }
  if (args.help) {
    console.log(USAGE)
    return
  }

  // Before any work: no key, no run.
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    fail(
      'Chybí ANTHROPIC_API_KEY / ANTHROPIC_API_KEY is not set.\n' +
        'Nastav klíč v prostředí (export ANTHROPIC_API_KEY=...) a spusť znovu. Nic nebylo spuštěno ani zaplaceno.\n' +
        'Set the key in your shell environment and run again. Nothing was run or billed.',
    )
  }

  const set = EVAL_SETS[args.set]
  const template = DEFAULT_TEMPLATES.find((t) => t.id === set?.templateId)
  if (!set || !template) fail(`Set "${args.set}" is not configured.`)

  const cardDir = process.env[set.cardDirEnv] ?? set.cardDirDefault
  let index
  try {
    index = await indexFilesByBasename(cardDir)
  } catch {
    fail(`Složka s klipy není dostupná / clip folder not readable: ${cardDir}\nZasuň kartu, nebo nastav ${set.cardDirEnv}.`)
  }
  const rows = parseReferenceCsv(await readFile(set.csvPath, 'utf8'))
  const matched = matchReference(rows, index, template)

  console.log(`Reference: ${rows.length} řádků, černé značky (kořen) přeskočeny: ${matched.skippedRoot}`)
  if (matched.unknownFolder.length > 0) console.warn(`Neznámá složka (přeskočeno): ${listNames(matched.unknownFolder)}`)
  if (matched.missing.length > 0) console.warn(`Nenalezeno na kartě (${matched.missing.length}): ${listNames(matched.missing)}`)
  if (matched.ambiguous.length > 0) console.warn(`Název víckrát na kartě (přeskočeno): ${listNames(matched.ambiguous)}`)

  const clips = args.limit === undefined ? matched.clips : matched.clips.slice(0, args.limit)
  if (clips.length === 0) fail('Žádné klipy k vyhodnocení / no clips to evaluate.')

  const estimate = estimateRun(clips.length, args.model, args.czk)
  console.log(
    `Odhad nákladů: ${clips.length} klipů x ${args.model} = ~${estimate.usd.toFixed(3)} USD (~${estimate.czk.toFixed(2)} Kč), hrubý odhad bez cache.`,
  )
  if (!args.yes) {
    console.log('Nic nespuštěno. Pro skutečné volání API přidej --yes. / Nothing was run; add --yes to call the API.')
    return
  }

  const classifier = new ClaudeClassifier({ apiKey, model: args.model })
  const results = await runEval({
    clips,
    classifier,
    template,
    prepare: async (absPath) => {
      const meta = await probeClip(absPath)
      return { meta, sheetJpeg: await contactSheet(absPath, meta.durationS) }
    },
    onProgress: (done, total, row) =>
      console.log(`[${done}/${total}] ${row.original}: ${row.expected} -> ${row.predicted} ${row.ok ? 'OK' : 'CHYBA'}${row.error ? ` (${row.error})` : ''}`),
  })

  const outFile = join('eval-results', `${set.id}-${args.model}.csv`)
  await writeResultsCsv(outFile, results)
  console.log(
    '\n' + formatSummary({ set: set.id, model: args.model, rows: results, categories: template.categories.map((c) => c.name), czkRate: args.czk }),
  )
  console.log(`\nVýsledky: ${outFile}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
