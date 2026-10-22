import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import {
  ClaudeClassifier,
  buildSystemPrompt,
  makeAnthropicClient,
  sanitizeResult,
  type ClassifyInput,
} from '../../src/core/classifier'
import { costUsd } from '../../src/core/pricing'
import { DEFAULT_TEMPLATES, UNCLASSIFIED, type Template } from '../../src/core/templates'

const fotbal = DEFAULT_TEMPLATES[0] as Template
const roster = [{ number: 9, surname: 'Kačor' }]

type FakeResponse = {
  parsed_output: unknown
  stop_reason: string
  model?: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number | null
    cache_creation_input_tokens: number | null
  }
}

const usage = {
  input_tokens: 1200,
  output_tokens: 30,
  cache_read_input_tokens: 800,
  cache_creation_input_tokens: 0,
}

function ok(parsed: unknown, extra: Partial<FakeResponse> = {}): FakeResponse {
  return { parsed_output: parsed, stop_reason: 'end_turn', usage, ...extra }
}

type Captured = { params: Record<string, unknown> | null }

function fakeClient(respond: () => Promise<FakeResponse>, captured?: Captured): Anthropic {
  const parse = (params: Record<string, unknown>): Promise<FakeResponse> => {
    if (captured) captured.params = params
    return respond()
  }
  return { beta: { messages: { parse } } } as unknown as Anthropic
}

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    sheetJpeg: Buffer.from([0xff, 0xd8, 0xff]),
    meta: {
      durationS: 12.34,
      width: 3840,
      height: 2160,
      fps: 25,
      createdAt: new Date('2026-10-22T10:00:00Z'),
      cameraModel: null,
    },
    fileName: 'C0012.MP4',
    template: fotbal,
    roster,
    ...over,
  }
}

function classifier(respond: () => Promise<FakeResponse>, captured?: Captured): ClaudeClassifier {
  return new ClaudeClassifier({
    apiKey: 'sk-test-not-real',
    model: 'claude-sonnet-5-5',
    client: fakeClient(respond, captured),
  })
}

describe('ClaudeClassifier.classify', () => {
  it('maps a valid response to a sanitized result with usage', async () => {
    const c = classifier(async () =>
      ok({ category: 'Zápas', description: 'Gól Kačor', confidence: 'high' }, { model: 'claude-sonnet-5-5' }),
    )
    const r = await c.classify(input())
    expect(r).toMatchObject({
      ok: true,
      category: 'Zápas',
      description: 'gol-kacor',
      confidence: 'high',
    })
    expect(r.usage).toEqual({
      input: 1200,
      output: 30,
      cacheRead: 800,
      cacheWrite: 0,
      model: 'claude-sonnet-5-5',
    })
  })

  it('sends the documented request shape', async () => {
    const cap: Captured = { params: null }
    const c = classifier(
      async () => ok({ category: 'Zápas', description: 'sance', confidence: 'low' }),
      cap,
    )
    await c.classify(input({ handLabel: 'šance' }))
    const p = cap.params as Record<string, unknown>
    expect(p.model).toBe('claude-sonnet-5-5')
    expect(p.max_tokens).toBe(1024)
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.fallbacks).toBe('default')
    expect((p.output_config as { effort: string }).effort).toBe('low')
    expect(p).not.toHaveProperty('thinking')
    expect(p).not.toHaveProperty('temperature')
    const system = p.system as Array<{ type: string; text: string; cache_control: unknown }>
    expect(system).toHaveLength(1)
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[0]?.text).toBe(buildSystemPrompt(fotbal, roster))
    const messages = p.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    const [img, txt] = messages[0]?.content ?? []
    expect(img).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
    })
    expect(txt?.type).toBe('text')
    expect(txt?.text).toBe(
      'Soubor: C0012.MP4, délka 12.3 s, natočeno 2026-10-22T10:00:00.000Z, ruční popisek: šance',
    )
  })

  it('uses a dash when there is no hand label', async () => {
    const cap: Captured = { params: null }
    const c = classifier(
      async () => ok({ category: 'Zápas', description: 'sance', confidence: 'low' }),
      cap,
    )
    await c.classify(input({ meta: { ...input().meta, createdAt: null } }))
    const messages = (cap.params as { messages: Array<{ content: Array<{ text?: string }> }> }).messages
    expect(messages[0]?.content[1]?.text).toContain('ruční popisek: –')
  })

  it('returns ok:false on refusal', async () => {
    const c = classifier(async () =>
      ok(null, { stop_reason: 'refusal' }),
    )
    const r = await c.classify(input())
    expect(r.ok).toBe(false)
    expect(r.category).toBe(UNCLASSIFIED)
    expect(r.error).toBeTruthy()
  })

  it('returns ok:false when the output could not be parsed', async () => {
    const c = classifier(async () => ok(null, { stop_reason: 'max_tokens' }))
    const r = await c.classify(input())
    expect(r).toMatchObject({ ok: false, category: UNCLASSIFIED })
    expect(r.error).toBeTruthy()
  })

  it('catches APIConnectionError and returns ok:false with the message, marked as an API failure', async () => {
    const c = classifier(async () => {
      throw new Anthropic.APIConnectionError({ message: 'Connection error.' })
    })
    const r = await c.classify(input())
    expect(r).toMatchObject({ ok: false, category: UNCLASSIFIED, description: '', apiFailure: true })
    expect(r.error).toBe('Connection error.')
  })

  it('does not mark a refusal or an unparsable answer as an API failure', async () => {
    const refused = await classifier(async () => ok(null, { stop_reason: 'refusal' })).classify(input())
    const unparsable = await classifier(async () => ok(null, { stop_reason: 'max_tokens' })).classify(input())
    expect(refused.apiFailure).toBeUndefined()
    expect(unparsable.apiFailure).toBeUndefined()
  })

  it('does not mark a real SDK refusal or truncated answer as an API failure', async () => {
    const reply = (text: string, stopReason: string) =>
      new ClaudeClassifier({
        apiKey: 'sk-test-not-real',
        model: 'claude-sonnet-5-5',
        client: new Anthropic({
          apiKey: 'sk-test-not-real',
          maxRetries: 0,
          fetch: async () =>
            new Response(
              JSON.stringify({
                id: 'msg_test',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text }],
                stop_reason: stopReason,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        }),
      })
    const refused = await reply('I cannot help with that.', 'refusal').classify(input())
    const truncated = await reply('{"category": "Z', 'max_tokens').classify(input())
    expect(refused).toMatchObject({ ok: false, category: UNCLASSIFIED })
    expect(truncated).toMatchObject({ ok: false, category: UNCLASSIFIED })
    expect(refused.apiFailure).toBeUndefined()
    expect(truncated.apiFailure).toBeUndefined()
  })

  it('marks an HTTP error from the real SDK as an API failure', async () => {
    const c = new ClaudeClassifier({
      apiKey: 'sk-test-not-real',
      model: 'claude-sonnet-5-5',
      client: new Anthropic({
        apiKey: 'sk-test-not-real',
        maxRetries: 0,
        fetch: async () =>
          new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
            status: 529,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    })
    const r = await c.classify(input())
    expect(r).toMatchObject({ ok: false, category: UNCLASSIFIED, apiFailure: true })
  })

  it('never throws on non-Error rejections', async () => {
    const c = classifier(async () => {
      throw 'boom'
    })
    const r = await c.classify(input())
    expect(r).toMatchObject({ ok: false, category: UNCLASSIFIED, error: 'boom' })
  })
})

describe('makeAnthropicClient', () => {
  it('gives up on a request after 60 s and retries at most twice', () => {
    const client = makeAnthropicClient('sk-test-not-real')
    expect(client.timeout).toBe(60_000)
    expect(client.maxRetries).toBe(2)
  })
})

describe('sanitizeResult', () => {
  const base = { confidence: 'medium' as const }

  it('falls back to _nezařazeno for a category outside the template but stays ok', () => {
    const r = sanitizeResult({ category: 'Zapas', description: 'sance', ...base }, fotbal)
    expect(r).toMatchObject({ ok: true, category: UNCLASSIFIED, description: 'sance' })
  })

  it('accepts _nezařazeno from the model', () => {
    const r = sanitizeResult({ category: '_nezařazeno', description: 'nejasne', ...base }, fotbal)
    expect(r).toMatchObject({ ok: true, category: UNCLASSIFIED, description: 'nejasne' })
  })

  it('accepts decomposed (NFD) category names', () => {
    const r = sanitizeResult(
      { category: 'Zápas', description: 'sance', ...base },
      fotbal,
    )
    expect(r.category).toBe('Zápas')
  })

  it('uses "klip" for an empty description', () => {
    expect(sanitizeResult({ category: 'Zápas', description: '', ...base }, fotbal).description).toBe('klip')
    expect(sanitizeResult({ category: 'Zápas', description: '!!!', ...base }, fotbal).description).toBe('klip')
  })

  it('strips a leading category slug', () => {
    expect(
      sanitizeResult({ category: 'Zápas', description: 'zapas-sance', ...base }, fotbal).description,
    ).toBe('sance')
    expect(
      sanitizeResult({ category: 'Zápas', description: 'Zápas', ...base }, fotbal).description,
    ).toBe('klip')
  })

  it('does not strip a category slug that is only a prefix of a word', () => {
    expect(
      sanitizeResult({ category: 'Zápas', description: 'zapasovy-tym', ...base }, fotbal).description,
    ).toBe('zapasovy-tym')
  })

  it('prefixes the hand label slug unless the description already starts with it', () => {
    expect(
      sanitizeResult({ category: 'Zápas', description: 'strela', ...base }, fotbal, 'šance').description,
    ).toBe('sance-strela')
    expect(
      sanitizeResult({ category: 'Zápas', description: 'sance-strela', ...base }, fotbal, 'šance').description,
    ).toBe('sance-strela')
    expect(
      sanitizeResult({ category: 'Zápas', description: '', ...base }, fotbal, 'šance').description,
    ).toBe('sance')
  })

  it('limits the description to 40 characters without a trailing hyphen', () => {
    const r = sanitizeResult(
      { category: 'Zápas', description: 'a'.repeat(39) + ' bbbb', ...base },
      fotbal,
    )
    expect(r.description.length).toBeLessThanOrEqual(40)
    expect(r.description.endsWith('-')).toBe(false)
  })

  it('returns ok:false for malformed raw data', () => {
    expect(sanitizeResult(null, fotbal)).toMatchObject({ ok: false, category: UNCLASSIFIED })
    expect(sanitizeResult({ category: 'Zápas' }, fotbal)).toMatchObject({ ok: false, category: UNCLASSIFIED })
    expect(
      sanitizeResult({ category: 'Zápas', description: 'x', confidence: 'sure' }, fotbal),
    ).toMatchObject({ ok: false })
  })
})

describe('buildSystemPrompt', () => {
  it('contains every category, hints, the roster and is byte-identical across calls', () => {
    const a = buildSystemPrompt(fotbal, roster)
    const b = buildSystemPrompt(fotbal, roster)
    expect(a).toBe(b)
    for (const c of fotbal.categories) {
      expect(a).toContain(c.name)
      expect(a).toContain(c.hint)
    }
    expect(a).toContain('9 Kačor')
    expect(a).toContain('_nezařazeno')
  })

  it('omits the roster section for an empty roster and differs per template', () => {
    const a = buildSystemPrompt(fotbal, [])
    expect(a).not.toContain('Kačor')
    expect(buildSystemPrompt(DEFAULT_TEMPLATES[1] as Template, [])).not.toBe(a)
  })
})

describe('costUsd', () => {
  it('computes Sonnet cost with cache read and cache write at 1.25x input', () => {
    const c = costUsd({
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      model: 'claude-sonnet-5-5',
    })
    expect(c).toBeCloseTo(2.0 + 10.0 + 0.2 + 2.5, 10)
  })

  it('prices Opus and Haiku from the table', () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }
    expect(costUsd({ ...u, model: 'claude-opus-5-5' })).toBeCloseTo(4 + 20 + 0.2, 10)
    expect(costUsd({ ...u, model: 'claude-haiku-5-5' })).toBeCloseTo(0.1 + 0.5 + 0.01, 10)
  })

  it('throws for an unknown model', () => {
    expect(() =>
      costUsd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, model: 'gpt-x' }),
    ).toThrow(/gpt-x/)
  })
})
