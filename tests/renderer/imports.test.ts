import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect, it } from 'vitest'

const root = path.resolve(new URL('../..', import.meta.url).pathname)
// `[^'"]` cannot run past another import's module string, so one match is one import statement
const VALUE_IMPORT = /^import\s+(?!type\b)[^'"]*?\sfrom\s+'(\.[^']+)'/gm

function resolveModule(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Node built-ins a module pulls in through its value imports (transitively). */
function nodeImports(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return []
  seen.add(file)
  const text = fs.readFileSync(file, 'utf8')
  const found: string[] = []
  for (const m of text.matchAll(/^import\s+(?!type\b)[^'"]*?\sfrom\s+'(node:[^']+)'/gm)) found.push(`${path.relative(root, file)} -> ${m[1]}`)
  for (const m of text.matchAll(VALUE_IMPORT)) {
    const target = resolveModule(file, m[1]!)
    if (target !== null) found.push(...nodeImports(target, seen))
  }
  return found
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

it('the renderer never pulls Node built-ins in through a value import (the sandboxed window has no Node)', () => {
  const offenders = walk(path.join(root, 'src/renderer')).flatMap((f) => nodeImports(f))
  expect(offenders).toEqual([])
})
