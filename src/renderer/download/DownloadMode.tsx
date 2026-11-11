import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus, PlanSummary, PreflightInfo, RunDone, RunStatusInfo, ScanProgress, SignOutResult, StartResult } from '../../shared/download-ipc'
import { api } from './api'
import { afterAuthCheck, type DownloadScreen } from './auth-refresh'
import { Choose } from './screens/Choose'
import { Done } from './screens/Done'
import { Progress, initialProgress, progressFromStatus, reduceProgress, staleProgress, type ProgressState } from './screens/Progress'
import { AccountBar, SignIn } from './screens/SignIn'
import { downloadStatusText } from '../shell-state'
import { GENERIC_ERROR, LOADING } from './strings'

type Screen = DownloadScreen
type Scanned = { scanId: string; plan: PlanSummary; link: string }

/** Main returns Czech error values instead of throwing; this only guards against an unexpected rejection. */
async function guarded<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call()
  } catch {
    return fallback
  }
}

type DownloadModeProps = {
  /** The shell shows this mode right now. */
  visible: boolean
  /** Status line for the home screen; `null` when no download runs. */
  onStatus: (text: string | null) => void
}

export function DownloadMode({ visible, onStatus }: DownloadModeProps) {
  const [auth, setAuth] = useState<AuthStatus>({ signedIn: false, email: null })
  const [screen, setScreen] = useState<Screen>('loading')
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanned, setScanned] = useState<Scanned | null>(null)
  const [preflight, setPreflight] = useState<PreflightInfo | null>(null)
  const [destError, setDestError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const [progress, setProgress] = useState<ProgressState>(() => initialProgress(0))
  const [done, setDone] = useState<RunDone | null>(null)
  const [doneBusy, setDoneBusy] = useState(false)
  const [doneError, setDoneError] = useState<string | null>(null)

  const scannedRef = useRef(scanned)
  scannedRef.current = scanned
  const scanSeq = useRef(0)
  /** `run:done` can arrive before the reply of `startRun`/`retryFailed` (a run that ends at once). */
  const runDoneRef = useRef(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  // Startup: who is signed in, and is a download already running (the window was reloaded or reopened)?
  useEffect(() => {
    let alive = true
    void Promise.all([
      guarded(() => api().authStatus(), { signedIn: false, email: null } as AuthStatus),
      guarded<RunStatusInfo>(() => api().runStatus(), { running: false }),
    ]).then(([status, run]) => {
      if (!alive) return
      setAuth(status)
      if (run.running) setProgress(progressFromStatus(run))
      const next: Screen = run.running ? 'progress' : status.signedIn ? 'choose' : 'signin'
      // A run:done that arrived meanwhile has already put the result on screen.
      setScreen((current) => (current === 'loading' ? next : current))
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const offScan = api().onScanProgress((p) => setScanProgress(p))
    const offEvent = api().onRunEvent((event) => setProgress((p) => reduceProgress(p, event, Date.now())))
    const offDone = api().onRunDone((result) => {
      runDoneRef.current = true
      setDone(result)
      setDoneBusy(false)
      setDoneError(null)
      setScreen('done')
      // An `auth_lost` run has dropped the stored sign-in; the header and the Done buttons follow the truth.
      void guarded(() => api().authStatus(), null).then((status) => {
        if (status !== null) setAuth(status)
      })
    })
    return () => {
      offScan()
      offEvent()
      offDone()
    }
  }, [])


  const runningDownload = screen === 'progress'
  useEffect(() => {
    onStatus(runningDownload ? downloadStatusText(progress) : null)
  }, [onStatus, runningDownload, progress])

  // A stalled download must not keep showing the last speed and ETA.
  useEffect(() => {
    if (screen !== 'progress') return
    const timer = setInterval(() => setProgress((p) => staleProgress(p, Date.now())), 1000)
    return () => clearInterval(timer)
  }, [screen])

  const resetChoose = useCallback(() => {
    scanSeq.current += 1
    setScanning(false)
    setScanProgress(null)
    setScanError(null)
    setScanned(null)
    setPreflight(null)
    setDestError(null)
    setStartError(null)
    setStarting(false)
  }, [])

  // Signing out in the settings (or a lost sign-in) is picked up when the mode is shown again.
  const screenRef = useRef(screen)
  screenRef.current = screen
  useEffect(() => {
    if (!visible) return
    let alive = true
    void guarded(() => api().authStatus(), null).then((status) => {
      if (!alive || status === null) return
      setAuth(status)
      const next = afterAuthCheck(screenRef.current, status.signedIn)
      if (next.reset) resetChoose()
      setScreen(next.screen)
    })
    return () => {
      alive = false
    }
  }, [visible, resetChoose])

  const signIn = useCallback(async (): Promise<boolean> => {
    setSigningIn(true)
    setSignInError(null)
    const result = await guarded(() => api().signIn(), { ok: false, error: GENERIC_ERROR } as const)
    setSigningIn(false)
    if (!result.ok) {
      setSignInError(result.error)
      return false
    }
    setAuth({ signedIn: true, email: result.email })
    return true
  }, [])

  const onSignIn = useCallback(() => {
    void signIn().then((ok) => {
      if (ok) setScreen('choose')
    })
  }, [signIn])

  const onSignOut = useCallback(() => {
    setSignOutError(null)
    void guarded<SignOutResult>(() => api().signOut(), { ok: false, error: GENERIC_ERROR }).then((result) => {
      if (!result.ok) {
        setSignOutError(result.error)
        return
      }
      setAuth({ signedIn: false, email: null })
      resetChoose()
      setDone(null)
      setSignInError(null)
      setScreen('signin')
    })
  }, [resetChoose])

  const onScan = useCallback((link: string) => {
    const seq = ++scanSeq.current
    setScanning(true)
    setScanProgress(null)
    setScanError(null)
    setScanned(null)
    setPreflight(null)
    setDestError(null)
    setStartError(null)
    void guarded(() => api().scan(link), { ok: false, error: GENERIC_ERROR } as const).then((result) => {
      if (seq !== scanSeq.current) return
      setScanning(false)
      if (result.ok) setScanned({ scanId: result.scanId, plan: result.plan, link })
      else setScanError(result.error)
    })
  }, [])

  const onPickDestination = useCallback(() => {
    const current = scannedRef.current
    if (current === null) return
    setDestError(null)
    setStartError(null)
    void guarded(() => api().pickDestination(current.scanId), { ok: false, error: GENERIC_ERROR } as const).then((result) => {
      if (result === null) return
      if (result.ok) setPreflight(result.preflight)
      else {
        setPreflight(null)
        setDestError(result.error)
      }
    })
  }, [])

  /** Events can arrive before the reply of `startRun`, so the progress is reset before the call, not after. */
  const resetProgress = useCallback(() => {
    const plan = scannedRef.current?.plan
    setProgress(initialProgress(plan?.fileCount ?? 0, plan?.totalBytes ?? 0))
    runDoneRef.current = false
  }, [])

  const onStart = useCallback(() => {
    const current = scannedRef.current
    if (current === null) return
    setStarting(true)
    setStartError(null)
    resetProgress()
    void guarded<StartResult>(() => api().startRun(current.scanId), { ok: false, error: GENERIC_ERROR }).then((result) => {
      setStarting(false)
      // A run that already finished has put the result on screen; entering Progress now would hide it.
      if (!result.ok) setStartError(result.error)
      else if (!runDoneRef.current) setScreen('progress')
    })
  }, [resetProgress])

  /** Runs the last plan again into the same destination (the journal skips what is verified). */
  const rerun = useCallback(
    async (signInFirst: boolean) => {
      setDoneBusy(true)
      setDoneError(null)
      if (signInFirst && !(await signIn())) {
        setDoneBusy(false)
        return
      }
      resetProgress()
      const result = await guarded<StartResult>(() => api().retryFailed(), { ok: false, error: GENERIC_ERROR })
      if (result.ok) {
        // `doneBusy` is reset by the next `run:done`; if that already came, the new result is on screen.
        if (runDoneRef.current) setDoneBusy(false)
        else setScreen('progress')
      } else {
        setDoneBusy(false)
        setDoneError(result.error)
      }
    },
    [signIn, resetProgress],
  )

  const onNext = useCallback(() => {
    resetChoose()
    setDone(null)
    setScreen(auth.signedIn ? 'choose' : 'signin')
  }, [auth.signedIn, resetChoose])

  const onChooseOther = useCallback(() => {
    setPreflight(null)
    setDestError(null)
    setStartError(null)
    setDone(null)
    setScreen(auth.signedIn ? 'choose' : 'signin')
  }, [auth.signedIn])

  const running = screen === 'progress' || starting || doneBusy

  let body: React.ReactNode
  if (screen === 'loading') {
    body = <p className="muted">{LOADING}</p>
  } else if (screen === 'signin') {
    body = <SignIn busy={signingIn} error={signInError} onSignIn={onSignIn} />
  } else if (screen === 'progress') {
    body = <Progress progress={progress} onAbort={() => void guarded(() => api().abortRun(), undefined)} />
  } else if (screen === 'done' && done !== null) {
    body = (
      <Done
        done={done}
        busy={doneBusy || signingIn}
        error={doneError ?? signInError}
        needsSignIn={!auth.signedIn}
        onRetry={() => void rerun(false)}
        onContinue={() => void rerun(!auth.signedIn)}
        onShow={() => void guarded(() => api().showDestination(), undefined)}
        onNext={onNext}
        onChooseOther={onChooseOther}
      />
    )
  } else {
    body = (
      <Choose
        initialLink={scanned?.link ?? ''}
        scanning={scanning}
        scanProgress={scanProgress}
        scanError={scanError}
        plan={scanned?.plan ?? null}
        preflight={preflight}
        destError={destError}
        startError={startError}
        starting={starting}
        onScan={onScan}
        onPickDestination={onPickDestination}
        onStart={onStart}
      />
    )
  }

  return (
    <div className="stack">
      {auth.signedIn && auth.email !== null && <AccountBar email={auth.email} running={running} onSignOut={onSignOut} />}
      {signOutError !== null && (
        <p className="callout bad" role="alert">
          {signOutError}
        </p>
      )}
      {body}
    </div>
  )
}
