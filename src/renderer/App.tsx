import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CardDetected, RunStartRequest, RunUiEvent, Settings } from '../shared/ipc-types'
import { Done, RunFailed } from './screens/Done'
import { Idle } from './screens/Idle'
import { NewCard, type StartForm } from './screens/NewCard'
import { Progress } from './screens/Progress'
import { SettingsScreen } from './screens/Settings'
import { addRecent, loadRecent, type RecentRun } from './recent'
import { isActive, newRun, reduceRun, type RunState } from './runState'

type View = { name: 'idle' } | { name: 'newcard' } | { name: 'run'; id: string } | { name: 'settings' }
export type Pending = { card: CardDetected; preset?: { eventName: string; isNew: boolean } }

type RunsAction = { kind: 'add'; run: RunState } | { kind: 'event'; cardRoot: string; event: RunUiEvent } | { kind: 'remove'; id: string }

function runsReducer(state: RunState[], action: RunsAction): RunState[] {
  switch (action.kind) {
    case 'add':
      return [...state.filter((r) => r.cardRoot !== action.run.cardRoot), action.run]
    case 'event':
      return state.map((r) => (r.cardRoot === action.cardRoot ? reduceRun(r, action.event) : r))
    case 'remove':
      return state.filter((r) => r.id !== action.id)
  }
}

function joinPath(dir: string, name: string): string {
  return `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${name}`
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [hasKey, setHasKey] = useState(false)
  const [view, setView] = useState<View>({ name: 'idle' })
  const [pending, setPending] = useState<Pending[]>([])
  const [runs, dispatch] = useReducer(runsReducer, [])
  const [recent, setRecent] = useState<RecentRun[]>(loadRecent)
  const [cards, setCards] = useState<Record<string, CardDetected>>({})
  const recorded = useRef(new Set<string>())
  const viewRef = useRef(view)
  viewRef.current = view
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const reloadSettings = useCallback(async () => {
    setSettings(await window.api.getSettings())
    setHasKey(await window.api.hasApiKey())
  }, [])

  useEffect(() => {
    void reloadSettings()
  }, [reloadSettings])

  const addPending = useCallback((entry: Pending) => {
    setCards((c) => ({ ...c, [entry.card.root]: entry.card }))
    setPending((list) => {
      const previous = list.find((p) => p.card.root === entry.card.root)
      const preset = entry.preset ?? previous?.preset
      return [...list.filter((p) => p.card.root !== entry.card.root), preset ? { ...entry, preset } : entry]
    })
    if (viewRef.current.name !== 'settings') setView({ name: 'newcard' })
  }, [])

  useEffect(() => {
    const offCard = window.api.onCardDetected((card) => addPending({ card }))
    const offRun = window.api.onRunEvent(({ cardRoot, event }) => dispatch({ kind: 'event', cardRoot, event }))
    return () => {
      offCard()
      offRun()
    }
  }, [addPending])

  // remember finished runs for the idle screen
  useEffect(() => {
    for (const run of runs) {
      if (recorded.current.has(run.id)) continue
      if (run.phase === 'finished' && run.summary) {
        recorded.current.add(run.id)
        const entry: RecentRun = { id: run.id, eventName: run.eventName, finishedAt: Date.now(), status: run.summary.status }
        setRecent((list) => addRecent(list, entry))
      } else if (run.phase === 'failed') {
        recorded.current.add(run.id)
        const entry: RecentRun = { id: run.id, eventName: run.eventName, finishedAt: Date.now(), status: 'failed' }
        setRecent((list) => addRecent(list, entry))
      }
    }
  }, [runs])

  const goHome = useCallback(() => {
    setView(pending.length > 0 ? { name: 'newcard' } : { name: 'idle' })
  }, [pending.length])

  const startRun = useCallback(
    async (card: CardDetected, form: StartForm): Promise<string | null> => {
      if (settings === null || settings.rootDir === null) return 'Nejdřív vyber složku na Disku v nastavení.'
      const template = settings.templates.find((t) => t.id === form.templateId)
      if (!template) return 'Vybraná šablona neexistuje.'
      const eventName = form.eventName.trim()
      const run = newRun({
        cardRoot: card.root,
        eventName,
        eventDir: joinPath(settings.rootDir, eventName),
        templateName: template.name,
        startedAt: Date.now(),
      })
      dispatch({ kind: 'add', run })
      const request: RunStartRequest = { cardRoot: card.root, eventName, isNew: form.isNew, templateId: form.templateId, rosterText: form.rosterText }
      let result: Awaited<ReturnType<typeof window.api.startRun>>
      try {
        result = await window.api.startRun(request)
      } catch (e) {
        dispatch({ kind: 'remove', id: run.id })
        return e instanceof Error ? e.message : 'Zálohu se nepodařilo spustit.'
      }
      if (!result.ok) {
        dispatch({ kind: 'remove', id: run.id })
        return result.error
      }
      const rest = pendingRef.current.filter((p) => p.card.root !== card.root)
      setPending(rest)
      setView(rest.length > 0 ? { name: 'newcard' } : { name: 'run', id: run.id })
      void window.api.setSettings({ lastTemplateId: form.templateId }).then((r) => {
        if (r.ok) setSettings(r.settings)
      })
      return null
    },
    [settings],
  )

  const pickByHand = useCallback(async (): Promise<boolean> => {
    const card = await window.api.pickCardFolder()
    if (card === null) return false
    addPending({ card })
    return true
  }, [addPending])

  const dismissRun = useCallback(
    (id: string) => {
      dispatch({ kind: 'remove', id })
      setView(pending.length > 0 ? { name: 'newcard' } : { name: 'idle' })
    },
    [pending.length],
  )

  const rerun = useCallback(
    (run: RunState) => {
      const card = cards[run.cardRoot]
      if (!card) return
      dispatch({ kind: 'remove', id: run.id })
      addPending({ card, preset: { eventName: run.eventName, isNew: false } })
    },
    [cards, addPending],
  )

  const activeRuns = runs.filter(isActive)
  const current = view.name === 'run' ? runs.find((r) => r.id === view.id) : undefined

  let body: React.ReactNode
  if (settings === null) {
    body = <p className="muted">Načítám…</p>
  } else if (view.name === 'settings') {
    body = (
      <SettingsScreen
        settings={settings}
        hasKey={hasKey}
        onSettings={setSettings}
        onKeySaved={() => setHasKey(true)}
        onBack={goHome}
      />
    )
  } else if (view.name === 'newcard' && pending[0]) {
    const first = pending[0]
    body = (
      <NewCard
        key={first.card.root}
        card={first.card}
        preset={first.preset}
        settings={settings}
        waiting={pending.length - 1}
        onStart={(form) => startRun(first.card, form)}
        onCancel={() => {
          setPending((list) => list.slice(1))
          setView(pending.length > 1 ? { name: 'newcard' } : { name: 'idle' })
        }}
        onSettings={setSettings}
        onOpenSettings={() => setView({ name: 'settings' })}
      />
    )
  } else if (current) {
    if (current.phase === 'finished' && current.summary) {
      body = (
        <Done
          run={current}
          summary={current.summary}
          czkPerUsd={settings.czkPerUsd}
          canRerun={cards[current.cardRoot] !== undefined}
          onRerun={() => rerun(current)}
          onClose={() => dismissRun(current.id)}
        />
      )
    } else if (current.phase === 'failed') {
      body = (
        <RunFailed
          run={current}
          canRerun={cards[current.cardRoot] !== undefined}
          onRerun={() => rerun(current)}
          onClose={() => dismissRun(current.id)}
        />
      )
    } else {
      body = <Progress run={current} onBack={() => setView({ name: 'idle' })} />
    }
  } else {
    body = (
      <Idle
        settings={settings}
        pending={pending}
        activeRuns={activeRuns}
        finishedRuns={runs.filter((r) => !isActive(r))}
        recent={recent}
        onPick={pickByHand}
        onOpenRun={(id) => setView({ name: 'run', id })}
        onOpenPending={() => setView({ name: 'newcard' })}
        onOpenSettings={() => setView({ name: 'settings' })}
      />
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={goHome}>
          Třídění karet
        </button>
        {view.name !== 'settings' && (
          <button type="button" className="link" onClick={() => setView({ name: 'settings' })}>
            Nastavení
          </button>
        )}
      </header>
      <main className="content">{body}</main>
    </div>
  )
}
