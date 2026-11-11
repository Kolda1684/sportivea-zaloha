import * as fs from 'node:fs'
import { expect, it } from 'vitest'

const css = fs.readFileSync(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8')
const START = '/* ---- Stáhnout z Drivu'
const END = '/* ---- Shell'

/** Top-level selectors of a CSS chunk; at-rule bodies are searched for their inner selectors. */
function selectors(chunk: string): string[] {
  const out: string[] = []
  const body = chunk.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  while (i < body.length) {
    const open = body.indexOf('{', i)
    if (open < 0) break
    const head = body.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (depth > 0 && j < body.length) {
      if (body[j] === '{') depth++
      else if (body[j] === '}') depth--
      j++
    }
    if (head.startsWith('@media')) out.push(...selectors(body.slice(open + 1, j - 1)))
    else if (!head.startsWith('@keyframes')) out.push(...head.split(',').map((s) => s.trim()))
    i = j
  }
  return out
}

it('download-only rules cannot restyle the card screens', () => {
  const start = css.indexOf(START)
  const end = css.indexOf(END)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  // used outside the download mode too (Settings → Google účet, top bar links)
  const shared = new Set(['.account', '.account-email', '.link:disabled', '.link:focus-visible'])
  const unscoped = selectors(css.slice(start, end)).filter((s) => !s.startsWith('.mode-download ') && !shared.has(s))
  expect(unscoped).toEqual([])
})
