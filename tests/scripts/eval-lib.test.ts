import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EvalUsageError,
  aggregateCost,
  buildConfusion,
  estimateRun,
  formatConfusion,
  indexFilesByBasename,
  matchReference,
  parseEvalArgs,
  parseReferenceCsv,
  runEval,
  writeResultsCsv,
  type EvalRow,
} from '../../scripts/eval-lib'
import type { Classifier, ClassifyInput, ClassifyResult } from '../../src/core/cards/classifier'
import type { ClipMeta } from '../../src/core/cards/probe'
import { DEFAULT_TEMPLATES, UNCLASSIFIED } from '../../src/core/cards/templates'

const fotbal = DEFAULT_TEMPLATES.find((t) => t.id === 'fotbal')!

const CSV =
  '﻿puvodni_nazev;novy_nazev;slozka;poznamka\r\n' +
  'A75_0343.MP4;_stadion_A75_0343.MP4;Trénink;\r\n' +
  'A75_0400.MP4;_gol_A75_0400.MP4;Zápas;"pozn; se středníkem"\r\n' +
  'A75_0500.MP4;_cerna_A75_0500.MP4;(kořen);\r\n' +
  'A75_0600.MP4;_neco_A75_0600.MP4;neznámá;\r\n'

describe('parseReferenceCsv', () => {
  it('strips BOM, reads header by name, handles quoted fields', () => {
    const rows = parseReferenceCsv(CSV)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ original: 'A75_0343.MP4', newName: '_stadion_A75_0343.MP4', folder: 'Trénink', note: '' })
    expect(rows[1]?.note).toBe('pozn; se středníkem')
  })

  it('rejects a file without the expected header', () => {
    expect(() => parseReferenceCsv('a;b;c\n1;2;3\n')).toThrow(/puvodni_nazev/)
  })

  it('ignores blank lines', () => {
    expect(parseReferenceCsv('puvodni_nazev;novy_nazev;slozka;poznamka\n\nx.MP4;y;Zápas;\n\n')).toHaveLength(1)
  })
})

describe('matchReference', () => {
  const rows = parseReferenceCsv(CSV)
  it('skips root rows, reports unknown folders and missing files', () => {
    const index = new Map([['a75_0343.mp4', ['/card/DAY 1/A75_0343.MP4']]])
    const m = matchReference(rows, index, fotbal)
    expect(m.clips).toEqual([{ original: 'A75_0343.MP4', expected: 'Trénink', absPath: '/card/DAY 1/A75_0343.MP4' }])
    expect(m.skippedRoot).toBe(1)
    expect(m.unknownFolder.map((r) => r.original)).toEqual(['A75_0600.MP4'])
    expect(m.missing.map((r) => r.original)).toEqual(['A75_0400.MP4'])
    expect(m.ambiguous).toEqual([])
  })

  it('treats a basename found in more than one folder as ambiguous', () => {
    const index = new Map([['a75_0343.mp4', ['/card/DAY 1/A75_0343.MP4', '/card/DAY 2/A75_0343.MP4']]])
    const m = matchReference(rows, index, fotbal)
    expect(m.clips).toEqual([])
    expect(m.ambiguous.map((r) => r.original)).toEqual(['A75_0343.MP4'])
  })

  it('matches folder names after NFC normalisation', () => {
    const nfd = 'puvodni_nazev;novy_nazev;slozka;poznamka\nx.MP4;y;Trénink;\n'
    const m = matchReference(parseReferenceCsv(nfd), new Map([['x.mp4', ['/c/x.MP4']]]), fotbal)
    expect(m.clips[0]?.expected).toBe('Trénink')
  })
})

describe('indexFilesByBasename', () => {
  it('walks subfolders and returns an empty map message-free for existing dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-idx-'))
    await mkdir(join(dir, 'DAY 1'))
    await mkdir(join(dir, 'DAY 2'))
    await writeFile(join(dir, 'DAY 1', 'A.MP4'), '')
    await writeFile(join(dir, 'DAY 2', 'b.mp4'), '')
    const idx = await indexFilesByBasename(dir)
    expect([...idx.keys()].sort()).toEqual(['a.mp4', 'b.mp4'])
    expect(idx.get('a.mp4')).toEqual([join(dir, 'DAY 1', 'A.MP4')])
  })

  it('rejects when the directory does not exist', async () => {
    await expect(indexFilesByBasename('/nonexistent-card-dir-xyz')).rejects.toThrow()
  })
})

describe('buildConfusion', () => {
  const rows: EvalRow[] = [
    mk('1', 'Trénink', 'Trénink'),
    mk('2', 'Trénink', 'Zápas'),
    mk('3', 'Zápas', 'Zápas'),
    mk('4', 'Zápas', 'Zápas'),
    mk('5', 'Zápas', UNCLASSIFIED, false),
  ]
  it('computes accuracy, per-category counts and API failures', () => {
    const c = buildConfusion(rows, fotbal.categories.map((x) => x.name))
    expect(c.total).toBe(5)
    expect(c.correct).toBe(3)
    expect(c.accuracy).toBeCloseTo(0.6)
    expect(c.apiFailures).toBe(1)
    expect(c.matrix['Trénink']?.['Zápas']).toBe(1)
    expect(c.matrix['Zápas']?.[UNCLASSIFIED]).toBe(1)
    expect(c.perCategory['Zápas']).toEqual({ n: 3, correct: 2, accuracy: 2 / 3 })
    expect(c.perCategory['rozcvička']).toEqual({ n: 0, correct: 0, accuracy: null })
  })

  it('returns accuracy 0 for no rows', () => {
    expect(buildConfusion([], ['a']).accuracy).toBe(0)
  })

  it('formats a readable table', () => {
    const text = formatConfusion(buildConfusion(rows, fotbal.categories.map((x) => x.name)))
    expect(text).toContain('Trénink')
    expect(text).toContain(UNCLASSIFIED)
  })
})

describe('aggregateCost', () => {
  it('sums usd and converts to CZK', () => {
    const rows = [mk('1', 'a', 'a', true, 0.01), mk('2', 'a', 'a', true, 0.02)]
    const c = aggregateCost(rows, 23)
    expect(c.usd).toBeCloseTo(0.03)
    expect(c.czk).toBeCloseTo(0.69)
  })
})

describe('estimateRun', () => {
  it('estimates from clip count and model price', () => {
    const e = estimateRun(100, 'claude-haiku-5-5', 23)
    expect(e.usd).toBeGreaterThan(0)
    expect(e.usd).toBeLessThan(0.1)
    expect(estimateRun(100, 'claude-sonnet-5-5', 23).usd).toBeGreaterThan(e.usd * 10)
    expect(estimateRun(0, 'claude-haiku-5-5', 23).usd).toBe(0)
  })
  it('rejects unknown models', () => {
    expect(() => estimateRun(1, 'gpt-x', 23)).toThrow()
  })
})

describe('parseEvalArgs', () => {
  it('applies defaults', () => {
    const a = parseEvalArgs(['--set', 'istanbul'])
    expect(a).toMatchObject({ set: 'istanbul', model: 'claude-sonnet-5-5', czk: 23, yes: false, help: false })
    expect(a.limit).toBeUndefined()
  })
  it('parses all options', () => {
    const a = parseEvalArgs(['--set', 'istanbul', '--model', 'claude-haiku-5-5', '--limit', '3', '--czk', '24.5', '--yes'])
    expect(a).toMatchObject({ model: 'claude-haiku-5-5', limit: 3, czk: 24.5, yes: true })
  })
  it('requires a known set', () => {
    expect(() => parseEvalArgs([])).toThrow(EvalUsageError)
    expect(() => parseEvalArgs(['--set', 'davis-cup'])).toThrow(/istanbul/)
  })
  it('rejects unknown model, bad limit, bad czk, unknown flag', () => {
    expect(() => parseEvalArgs(['--set', 'istanbul', '--model', 'gpt'])).toThrow(EvalUsageError)
    expect(() => parseEvalArgs(['--set', 'istanbul', '--limit', '0'])).toThrow(EvalUsageError)
    expect(() => parseEvalArgs(['--set', 'istanbul', '--limit', 'abc'])).toThrow(EvalUsageError)
    expect(() => parseEvalArgs(['--set', 'istanbul', '--czk', '-1'])).toThrow(EvalUsageError)
    expect(() => parseEvalArgs(['--set', 'istanbul', '--nope'])).toThrow(EvalUsageError)
  })
  it('--help needs no set', () => {
    expect(parseEvalArgs(['--help']).help).toBe(true)
  })
})

const META: ClipMeta = { durationS: 10, width: 1920, height: 1080, fps: 25, createdAt: null, cameraModel: null }

class FakeClassifier implements Classifier {
  calls: ClassifyInput[] = []
  constructor(private readonly answers: Record<string, Partial<ClassifyResult>>) {}
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    this.calls.push(input)
    const a = this.answers[input.fileName] ?? {}
    return {
      category: 'Zápas',
      description: 'gol',
      confidence: 'high',
      ok: true,
      usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, model: 'claude-haiku-5-5' },
      ...a,
    }
  }
}

describe('runEval', () => {
  const clips = [
    { original: 'A.MP4', expected: 'Zápas', absPath: '/c/A.MP4' },
    { original: 'B.MP4', expected: 'Trénink', absPath: '/c/B.MP4' },
    { original: 'C.MP4', expected: 'Zápas', absPath: '/c/C.MP4' },
  ]

  it('classifies every clip with the template and computes ok and usd', async () => {
    const fake = new FakeClassifier({ 'B.MP4': { category: 'Trénink' }, 'C.MP4': { category: 'nástup' } })
    const rows = await runEval({
      clips,
      classifier: fake,
      template: fotbal,
      prepare: async () => ({ meta: META, sheetJpeg: Buffer.from('x') }),
      concurrency: 2,
    })
    expect(rows.map((r) => r.ok)).toEqual([true, true, false])
    expect(rows.map((r) => r.original)).toEqual(['A.MP4', 'B.MP4', 'C.MP4'])
    expect(rows[0]?.usd).toBeCloseTo(0.1)
    expect(fake.calls[0]?.template).toBe(fotbal)
    expect(fake.calls[0]?.roster).toEqual([])
  })

  it('records a prepare error as a failed row without calling the classifier', async () => {
    const fake = new FakeClassifier({})
    const rows = await runEval({
      clips: [clips[0]!],
      classifier: fake,
      template: fotbal,
      prepare: async () => {
        throw new Error('ffmpeg boom')
      },
    })
    expect(fake.calls).toHaveLength(0)
    expect(rows[0]).toMatchObject({ predicted: UNCLASSIFIED, ok: false, apiOk: false, usd: 0 })
    expect(rows[0]?.error).toContain('ffmpeg boom')
  })

  it('records a classifier failure and a thrown classifier error', async () => {
    const fake = new FakeClassifier({ 'A.MP4': { ok: false, category: UNCLASSIFIED, error: 'rate limit', usage: undefined } })
    const throwing: Classifier = {
      classify: async (i) => {
        if (i.fileName === 'B.MP4') throw new Error('network')
        return fake.classify(i)
      },
    }
    const rows = await runEval({
      clips: clips.slice(0, 2),
      classifier: throwing,
      template: fotbal,
      prepare: async () => ({ meta: META, sheetJpeg: Buffer.from('x') }),
    })
    expect(rows.every((r) => !r.ok && !r.apiOk)).toBe(true)
    expect(rows[0]?.error).toBe('rate limit')
    expect(rows[1]?.error).toBe('network')
  })

  it('calls onProgress once per clip', async () => {
    const seen: number[] = []
    await runEval({
      clips,
      classifier: new FakeClassifier({}),
      template: fotbal,
      prepare: async () => ({ meta: META, sheetJpeg: Buffer.from('x') }),
      onProgress: (done) => seen.push(done),
    })
    expect(seen.sort()).toEqual([1, 2, 3])
  })
})

describe('writeResultsCsv', () => {
  it('writes BOM, header, escaped cells, creating the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-out-'))
    const file = join(dir, 'nested', 'istanbul-x.csv')
    await writeResultsCsv(file, [
      { ...mk('A.MP4', 'Zápas', 'Zápas', true, 0.001234), description: 'gol; "x"', confidence: 'high' },
    ])
    const text = await readFile(file, 'utf8')
    expect(text.startsWith('﻿original;expected;predicted;description;confidence;ok;usd;error')).toBe(true)
    expect(text).toContain('"gol; ""x"""')
    expect(text).toContain('A.MP4;Zápas;Zápas;')
    expect(text).toContain(';yes;0.001234;')
  })
})

function mk(original: string, expected: string, predicted: string, apiOk = true, usd = 0): EvalRow {
  return {
    original,
    expected,
    predicted,
    description: '',
    confidence: 'high',
    ok: predicted === expected,
    apiOk,
    usd,
  }
}
