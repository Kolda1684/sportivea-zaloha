export type TokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model: string
}

type Price = { input: number; output: number; cacheRead: number }

/** USD per 1M tokens. Cache write is billed at 1.25x the input price. */
const PRICES: Readonly<Record<string, Price>> = {
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
}

const CACHE_WRITE_MULTIPLIER = 1.25

export function isKnownModel(model: string): boolean {
  return Object.hasOwn(PRICES, model)
}

export function costUsd(u: TokenUsage): number {
  const p = Object.hasOwn(PRICES, u.model) ? PRICES[u.model] : undefined
  if (!p) throw new Error(`Unknown model for pricing: ${u.model}`)
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  )
}
