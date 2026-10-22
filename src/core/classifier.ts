import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { slugify } from './naming'
import { isKnownModel, type TokenUsage } from './pricing'
import type { ClipMeta } from './probe'
import type { RosterEntry } from './roster'
import { UNCLASSIFIED, type Template } from './templates'

export type ClassifyInput = {
  sheetJpeg: Buffer
  meta: ClipMeta
  fileName: string
  handLabel?: string
  template: Template
  roster: RosterEntry[]
}

export type ClassifyResult = {
  category: string
  description: string
  confidence: 'high' | 'medium' | 'low'
  ok: boolean
  error?: string
  usage?: TokenUsage
}

export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyResult>
}

const ResultSchema = z.object({
  category: z.string(),
  description: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
})

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const MAX_DESCRIPTION_LEN = 40

/** Stable per template + roster (no timestamps) so the prompt cache hits across clips. */
export function buildSystemPrompt(template: Template, roster: RosterEntry[]): string {
  const categories = template.categories.map((c) => `- ${c.name}: ${c.hint}`).join('\n')
  const lines = [
    'Třídíš záběry z natáčení sportovní akce. Dostaneš kontaktní náhled jednoho videoklipu (snímky z různých míst klipu) a jeho základní údaje.',
    '',
    'Vyber přesně jednu kategorii z tohoto seznamu (název: popis):',
    categories,
    '',
    `Pokud si nejsi jistý, vyber kategorii ${UNCLASSIFIED}. Název kategorie vrať přesně tak, jak je uvedený.`,
    '',
    'Pravidla pro popis klipu:',
    '- 1 až 4 slova česky, malými písmeny, bez diacritiky, spojená spojovníky.',
    '- Popiš, co se v klipu děje, například: gol-kacor, brankar-zakrok, fanousci-vlajky.',
    '- Nikdy neopakuj název kategorie.',
    '- Pokud je číslo na dresu jasně čitelné a je v soupisce níže, přidej do popisu příjmení hráče. Nikdy nehádej.',
    '- Pokud je zadán ruční popisek, zachovej jeho význam v popisu.',
    '',
    'Odpověz pouze strukturovaným výstupem: category, description a confidence (high, medium nebo low).',
  ]
  if (roster.length > 0) {
    lines.push('', 'Soupiska (číslo na dresu a příjmení):', ...roster.map((r) => `${r.number} ${r.surname}`))
  }
  return lines.join('\n')
}

function failure(error: string, usage?: TokenUsage): ClassifyResult {
  const r: ClassifyResult = {
    category: UNCLASSIFIED,
    description: '',
    confidence: 'low',
    ok: false,
    error,
  }
  if (usage) r.usage = usage
  return r
}

function stripCategory(description: string, categoryName: string): string {
  const cat = slugify(categoryName)
  if (!cat) return description
  if (description === cat) return ''
  return description.startsWith(`${cat}-`) ? description.slice(cat.length + 1) : description
}

export function sanitizeResult(raw: unknown, template: Template, handLabel?: string): ClassifyResult {
  const parsed = ResultSchema.safeParse(raw)
  if (!parsed.success) return failure('Neplatná odpověď modelu')
  const { category: rawCategory, description: rawDescription, confidence } = parsed.data

  const wanted = rawCategory.normalize('NFC')
  const match = template.categories.find((c) => c.name.normalize('NFC') === wanted)
  const category = match ? match.name : UNCLASSIFIED

  let description = slugify(rawDescription, MAX_DESCRIPTION_LEN)
  if (match) description = stripCategory(description, match.name)

  const label = handLabel ? slugify(handLabel, MAX_DESCRIPTION_LEN) : ''
  if (label && description !== label && !description.startsWith(`${label}-`)) {
    description = description ? `${label}-${description}` : label
  }
  description = slugify(description || 'klip', MAX_DESCRIPTION_LEN)

  return { category, description, confidence, ok: true }
}

type UsageLike = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

function toTokenUsage(u: UsageLike, requestedModel: string, answeredModel: string | undefined): TokenUsage {
  // With a server-side fallback the answering model can differ; bill it at its own price when known.
  const model = answeredModel && isKnownModel(answeredModel) ? answeredModel : requestedModel
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    model,
  }
}

export class ClaudeClassifier implements Classifier {
  private readonly client: Anthropic
  private readonly model: string

  constructor(opts: { apiKey: string; model: string; client?: Anthropic }) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey })
    this.model = opts.model
  }

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    try {
      const created = input.meta.createdAt ? input.meta.createdAt.toISOString() : 'neznámo'
      const label = input.handLabel ? input.handLabel : '–'
      const text = `Soubor: ${input.fileName}, délka ${input.meta.durationS.toFixed(1)} s, natočeno ${created}, ruční popisek: ${label}`

      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 1024,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort: 'low', format: zodOutputFormat(ResultSchema) },
        system: [
          {
            type: 'text',
            text: buildSystemPrompt(input.template, input.roster),
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: input.sheetJpeg.toString('base64'),
                },
              },
              { type: 'text', text },
            ],
          },
        ],
      })

      const usage = toTokenUsage(response.usage, this.model, response.model)
      if (response.stop_reason === 'refusal') return failure('Model odmítl klip zpracovat', usage)
      if (response.parsed_output == null) {
        return failure(`Odpověď modelu nešlo zpracovat (stop_reason: ${response.stop_reason ?? 'neznámý'})`, usage)
      }
      return { ...sanitizeResult(response.parsed_output, input.template, input.handLabel), usage }
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err))
    }
  }
}
