import { useId, useState } from 'react'
import type { Template } from '../../core/templates'
import type { Model, Settings } from '../../shared/ipc-types'

type Props = {
  settings: Settings
  hasKey: boolean
  onSettings(settings: Settings): void
  onKeySaved(): void
  onBack(): void
}

const MODELS: ReadonlyArray<{ value: Model; label: string }> = [
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5 — doporučeno' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5 — nejpřesnější, dražší' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5 — nejlevnější' },
]

function plainNameProblem(name: string): string | null {
  const n = name.trim()
  if (n === '') return 'Název nesmí být prázdný.'
  if (/[\\/]/.test(n) || n === '.' || n === '..') return 'Název nesmí obsahovat lomítka.'
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

function cleanTemplates(templates: Template[]): Template[] {
  return templates.map((t) => ({
    id: t.id,
    name: t.name.trim(),
    categories: t.categories.map((c) => ({ name: c.name.trim(), hint: c.hint.trim() })),
  }))
}

function RootFolder({ settings, onSettings }: Pick<Props, 'settings' | 'onSettings'>) {
  const [error, setError] = useState('')
  const pick = async (): Promise<void> => {
    setError('')
    const dir = await window.api.pickRootFolder()
    if (dir === null) return
    const result = await window.api.setSettings({ rootDir: dir })
    if (result.ok) onSettings(result.settings)
    else setError(result.error)
  }
  return (
    <div className="card stack tight">
      <h2>Složka pro akce</h2>
      <p className="muted small">Složka na Google Disku, do které se zakládají složky jednotlivých akcí.</p>
      <p className="path">{settings.rootDir ?? 'Zatím nevybraná'}</p>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => void pick()}>
          Vybrat složku
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

function ApiKey({ hasKey, onKeySaved }: Pick<Props, 'hasKey' | 'onKeySaved'>) {
  const id = useId()
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.setApiKey(key)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setKey('')
      if (await window.api.hasApiKey()) onKeySaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Klíč se nepodařilo uložit.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="card stack tight"
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim() !== '' && !busy) void save()
      }}
    >
      <h2>Klíč ke Claude</h2>
      <p className="muted small">Klíč se ukládá jen do klíčenky v tomhle Macu. Nikdy se nezobrazuje, ani po uložení.</p>
      <p>
        Stav: {hasKey ? <span className="tag ok">uloženo</span> : <span className="tag bad">není uložen</span>}
      </p>
      <label htmlFor={id}>{hasKey ? 'Nahradit klíč novým' : 'Vložit klíč'}</label>
      <input
        id={id}
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="sk-ant-…"
      />
      <div className="actions">
        <button type="submit" className="secondary" disabled={busy || key.trim() === ''}>
          Uložit klíč
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </form>
  )
}

function General({ settings, onSettings }: Pick<Props, 'settings' | 'onSettings'>) {
  const ids = { model: useId(), luma: useId(), czk: useId() }
  const [model, setModel] = useState<Model>(settings.model)
  const [luma, setLuma] = useState(String(settings.lumaThreshold).replace('.', ','))
  const [czk, setCzk] = useState(String(settings.czkPerUsd).replace('.', ','))
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const lumaNum = Number(luma.replace(',', '.'))
  const czkNum = Number(czk.replace(',', '.'))
  const valid = luma.trim() !== '' && czk.trim() !== '' && lumaNum >= 0 && lumaNum <= 1 && czkNum > 0 && czkNum <= 10_000
  const dirty = model !== settings.model || lumaNum !== settings.lumaThreshold || czkNum !== settings.czkPerUsd

  const save = async (): Promise<void> => {
    setMessage('')
    setError('')
    const result = await window.api.setSettings({ model, lumaThreshold: lumaNum, czkPerUsd: czkNum })
    if (result.ok) {
      onSettings(result.settings)
      setMessage('Uloženo.')
    } else {
      setError(result.error)
    }
  }

  return (
    <form
      className="card stack tight"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void save()
      }}
    >
      <h2>Model a hodnoty</h2>
      <label htmlFor={ids.model}>Model</label>
      <select id={ids.model} value={model} onChange={(e) => setModel(e.target.value as Model)}>
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <label htmlFor={ids.luma}>Práh černé značky (0 až 1)</label>
      <input id={ids.luma} type="text" inputMode="decimal" value={luma} onChange={(e) => setLuma(e.target.value)} />
      <p className="muted small">Klip, který je skoro celý tmavší než tohle, se pozná jako černá značka a nekopíruje se. Výchozí je 0,2.</p>
      <label htmlFor={ids.czk}>Kurz pro zobrazení ceny (Kč za 1 USD)</label>
      <input id={ids.czk} type="text" inputMode="decimal" value={czk} onChange={(e) => setCzk(e.target.value)} />
      {!valid && <p className="field-error">Práh musí být mezi 0 a 1, kurz kladné číslo.</p>}
      <div className="actions">
        <button type="submit" className="secondary" disabled={!valid || !dirty}>
          Uložit
        </button>
        {message && <span className="tag ok">{message}</span>}
      </div>
      {error && <p className="field-error">{error}</p>}
    </form>
  )
}

function TemplateEditor({ settings, onSettings }: Pick<Props, 'settings' | 'onSettings'>) {
  const selectId = useId()
  const [draft, setDraft] = useState<Template[]>(() => structuredClone(settings.templates))
  const [index, setIndex] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const safeIndex = Math.min(index, draft.length - 1)
  const template = draft[safeIndex]
  const problem = templatesProblem(draft)
  const dirty = JSON.stringify(cleanTemplates(draft)) !== JSON.stringify(settings.templates)

  const edit = (change: (t: Template) => Template): void => {
    setMessage('')
    setDraft((list) => list.map((t, i) => (i === safeIndex ? change(t) : t)))
  }

  const addTemplate = (): void => {
    setMessage('')
    const id = `sablona-${Date.now().toString(36)}`
    setDraft((list) => [...list, { id, name: 'Nová šablona', categories: [{ name: 'Kategorie', hint: '' }] }])
    setIndex(draft.length)
  }

  const removeTemplate = (): void => {
    if (draft.length <= 1) return
    setMessage('')
    setDraft((list) => list.filter((_, i) => i !== safeIndex))
    setIndex(0)
  }

  const save = async (): Promise<void> => {
    if (problem !== null) return
    setError('')
    setMessage('')
    const templates = cleanTemplates(draft)
    const patch: Partial<Settings> = { templates }
    if (!templates.some((t) => t.id === settings.lastTemplateId)) patch.lastTemplateId = templates[0]?.id ?? settings.lastTemplateId
    const result = await window.api.setSettings(patch)
    if (result.ok) {
      onSettings(result.settings)
      setDraft(structuredClone(result.settings.templates))
      setMessage('Šablony uloženy.')
    } else {
      setError(result.error)
    }
  }

  if (!template) return null

  return (
    <div className="card stack tight">
      <h2>Šablony kategorií</h2>
      <p className="muted small">Kategorie jsou názvy složek, do kterých se klipy třídí. Popis pomáhá poznat, co do které patří.</p>
      <label htmlFor={selectId}>Šablona</label>
      <div className="inline">
        <select id={selectId} value={safeIndex} onChange={(e) => setIndex(Number(e.target.value))}>
          {draft.map((t, i) => (
            <option key={t.id} value={i}>
              {t.name.trim() === '' ? '(bez názvu)' : t.name}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" onClick={addTemplate}>
          Přidat šablonu
        </button>
        <button type="button" className="secondary danger-text" onClick={removeTemplate} disabled={draft.length <= 1}>
          Odebrat šablonu
        </button>
      </div>

      <label>
        Název šablony
        <input type="text" value={template.name} onChange={(e) => edit((t) => ({ ...t, name: e.target.value }))} />
      </label>

      <ul className="plain categories">
        {template.categories.map((c, ci) => (
          <li key={ci} className="category">
            <input
              type="text"
              aria-label={`Kategorie ${ci + 1}: název`}
              value={c.name}
              placeholder="Název složky"
              onChange={(e) => edit((t) => ({ ...t, categories: t.categories.map((x, i) => (i === ci ? { ...x, name: e.target.value } : x)) }))}
            />
            <textarea
              rows={2}
              aria-label={`Kategorie ${ci + 1}: popis`}
              value={c.hint}
              placeholder="Co do téhle složky patří"
              onChange={(e) => edit((t) => ({ ...t, categories: t.categories.map((x, i) => (i === ci ? { ...x, hint: e.target.value } : x)) }))}
            />
            <button
              type="button"
              className="secondary danger-text"
              disabled={template.categories.length <= 1}
              onClick={() => edit((t) => ({ ...t, categories: t.categories.filter((_, i) => i !== ci) }))}
            >
              Odebrat
            </button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => edit((t) => ({ ...t, categories: [...t.categories, { name: '', hint: '' }] }))}>
          Přidat kategorii
        </button>
      </div>

      {problem !== null && <p className="field-error">{problem}</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={problem !== null || !dirty} onClick={() => void save()}>
          Uložit šablony
        </button>
        {dirty && message === '' && <span className="muted small">Neuložené změny</span>}
        {message && <span className="tag ok">{message}</span>}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

export function SettingsScreen({ settings, hasKey, onSettings, onKeySaved, onBack }: Props) {
  return (
    <section className="stack">
      <div className="titlebar">
        <h1>Nastavení</h1>
        <button type="button" className="secondary" onClick={onBack}>
          Zpět
        </button>
      </div>
      <RootFolder settings={settings} onSettings={onSettings} />
      <ApiKey hasKey={hasKey} onKeySaved={onKeySaved} />
      <General settings={settings} onSettings={onSettings} />
      <TemplateEditor settings={settings} onSettings={onSettings} />
    </section>
  )
}
