import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CardDetected, CardsApi, RunStartRequest, RunUiEvent, Settings } from '../../shared/cards-ipc'
import { api } from './api'
import { Done, RunFailed } from './screens/Done'
import { Idle } from './screens/Idle'
import { NewCard, type StartForm } from './screens/NewCard'
import { Progress } from './screens/Progress'
import { addRecent, loadRecent, type RecentRun } from './recent'
import { isActive, newRun, reduceRun, type RunState } from './runState'
import { cardsStatusText } from '../shell-state'
import { CARD_MODES, TOOLS_MISSING_MESSAGE } from './strings'

type View = { name: 'idle' } | { name: 'newcard' } | { name: 'run'; id: string }
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

type CardsModeProps = {
  /** The shell shows this mode right now. */
  visible: boolean
  /** Status line for the home screen; `null` when there is nothing to report. */
  onStatus: (text: string | null) => void
  /** A card was found: the shell switches to this mode (unless the settings are open). */
  onCardArrived: () => void
  /** The settings live in the shell (Google account + card settings). */
  onOpenSettings: () => void
}

export function CardsMode({ visible, onStatus, onCardArrived, onOpenSettings }: CardsModeProps) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [hasKey, setHasKey] = useState(false)
  /** null until the startup check of ffprobe/ffmpeg has answered. */
  const [toolsOk, setToolsOk] = useState<boolean | null>(null)
  const [view, setView] = useState<View>({ name: 'idle' })
  const [pending, setPending] = useState<Pending[]>([])
  const [runs, dispatch] = useReducer(runsReducer, [])
  const [recent, setRecent] = useState<RecentRun[]>(loadRecent)
  const [cards, setCards] = useState<Record<string, CardDetected>>({})
  const recorded = useRef(new Set<string>())
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const reloadSettings = useCallback(async () => {
    setSettings(await api().getSettings())
    setHasKey(await api().hasApiKey())
  }, [])

  // also after the settings were changed in the shell's settings screen
  useEffect(() => {
    if (visible) void reloadSettings()
  }, [visible, reloadSettings])

  useEffect(() => {
    let alive = true
    void api().toolsOk().then(
      (ok) => alive && setToolsOk(ok),
      () => alive && setToolsOk(false),
    )
    return () => {
      alive = false
    }
  }, [])

  const addPending = useCallback((entry: Pending) => {
    setCards((c) => ({ ...c, [entry.card.root]: entry.card }))
    setPending((list) => {
      const previous = list.find((p) => p.card.root === entry.card.root)
      const preset = entry.preset ?? previous?.preset
      return [...list.filter((p) => p.card.root !== entry.card.root), preset ? { ...entry, preset } : entry]
    })
    setView({ name: 'newcard' })
  }, [])

  useEffect(() => {
    const offCard = api().onCardDetected((card) => {
      addPending({ card })
      onCardArrived()
    })
    const offRun = api().onRunEvent(({ cardRoot, event }) => dispatch({ kind: 'event', cardRoot, event }))
    return () => {
      offCard()
      offRun()
    }
  }, [addPending, onCardArrived])

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
      const template = form.mode === 'sort' ? settings.templates.find((t) => t.id === form.templateId) : undefined
      if (form.mode === 'sort' && !template) return 'Vybraná šablona neexistuje.'
      const templateName = template?.name ?? CARD_MODES.find((m) => m.mode === form.mode)?.label ?? ''
      const eventName = form.eventName.trim()
      const run = newRun({
        cardRoot: card.root,
        eventName,
        eventDir: joinPath(settings.rootDir, eventName),
        templateName,
        startedAt: Date.now(),
      })
      dispatch({ kind: 'add', run })
      const request: RunStartRequest = {
        cardRoot: card.root,
        eventName,
        isNew: form.isNew,
        ...(form.mode === 'sort' ? { templateId: form.templateId } : {}),
        rosterText: form.rosterText,
        mode: form.mode,
      }
      let result: Awaited<ReturnType<CardsApi['startRun']>>
      try {
        result = await api().startRun(request)
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
      if (form.mode === 'sort') {
        void api().setSettings({ lastTemplateId: form.templateId }).then((r) => {
          if (r.ok) setSettings(r.settings)
        })
      }
      return null
    },
    [settings],
  )

  const pickByHand = useCallback(async (): Promise<boolean> => {
    const card = await api().pickCardFolder()
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
  const firstActive = activeRuns[0]
  const activeVolume = firstActive ? (cards[firstActive.cardRoot]?.volumeName ?? firstActive.cardRoot) : null
  useEffect(() => {
    onStatus(cardsStatusText({ activeVolume, activeCount: activeRuns.length, pending: pending.length }))
  }, [onStatus, activeVolume, activeRuns.length, pending.length])
  const current = view.name === 'run' ? runs.find((r) => r.id === view.id) : undefined

  let body: React.ReactNode
  if (settings === null) {
    body = <p className="muted">Načítám…</p>
  } else if (view.name === 'newcard' && pending[0]) {
    const first = pending[0]
    body = (
      <NewCard
        key={first.card.root}
        card={first.card}
        preset={first.preset}
        settings={settings}
        hasKey={hasKey}
        toolsOk={toolsOk !== false}
        waiting={pending.length - 1}
        onStart={(form) => startRun(first.card, form)}
        onCancel={() => {
          setPending((list) => list.slice(1))
          setView(pending.length > 1 ? { name: 'newcard' } : { name: 'idle' })
        }}
        onSettings={setSettings}
        onOpenSettings={onOpenSettings}
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
        onOpenSettings={onOpenSettings}
      />
    )
  }

  return (
    <div className="stack">
      {toolsOk === false && (
        <p className="callout bad" role="alert">
          {TOOLS_MISSING_MESSAGE}
        </p>
      )}
      {body}
    </div>
  )
}
