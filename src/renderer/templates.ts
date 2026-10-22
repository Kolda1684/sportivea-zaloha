import { OTHER_FILES, UNCLASSIFIED, type Template } from '../core/templates'

const RESERVED: ReadonlySet<string> = new Set([UNCLASSIFIED, OTHER_FILES])

function plainNameProblem(name: string): string | null {
  const n = name.trim()
  if (n === '') return 'Název nesmí být prázdný.'
  if (/[\\/]/.test(n) || n === '.' || n === '..') return 'Název nesmí obsahovat lomítka.'
  if (RESERVED.has(n.toLocaleLowerCase('cs'))) return `Název „${n}“ používá aplikace sama, zvol jiný.`
  return null
}

/** First problem in the edited templates, or null when they can be saved. */
export function templatesProblem(templates: Template[]): string | null {
  if (templates.length === 0) return 'Musí zůstat aspoň jedna šablona.'
  for (const t of templates) {
    if (t.name.trim() === '') return 'Každá šablona potřebuje název.'
    if (t.categories.length === 0) return `Šablona „${t.name}“ musí mít aspoň jednu kategorii.`
    const seen = new Set<string>()
    for (const c of t.categories) {
      const problem = plainNameProblem(c.name)
      if (problem !== null) return `Šablona „${t.name}“: ${problem}`
      const key = c.name.trim().toLocaleLowerCase('cs')
      if (seen.has(key)) return `Šablona „${t.name}“: kategorie „${c.name.trim()}“ je tam dvakrát.`
      seen.add(key)
    }
  }
  return null
}
