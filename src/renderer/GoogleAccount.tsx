import { useCallback, useEffect, useState } from 'react'
import { api } from './download/api'
import { GENERIC_ERROR, SIGN_OUT_DISABLED_HINT } from './download/strings'
import { NOT_SIGNED_IN, SIGN_OUT } from './strings'

type ViewProps = {
  email: string | null
  error: string | null
  busy: boolean
  /** A download runs: main refuses the sign-out, so the button is off. */
  running: boolean
  onSignOut: () => void
}

export function GoogleAccountView({ email, error, busy, running, onSignOut }: ViewProps) {
  return (
    <div className="stack tight">
      <div className="account">
        <span className={email === null ? 'muted' : 'strong'}>{email ?? NOT_SIGNED_IN}</span>
        {email !== null && (
          <button type="button" className="link" disabled={busy || running} onClick={onSignOut}>
            {SIGN_OUT}
          </button>
        )}
      </div>
      {email !== null && running && <p className="muted small">{SIGN_OUT_DISABLED_HINT}</p>}
      {error !== null && (
        <p className="callout bad" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Google account used for downloads; signing out is refused by main while a download runs. */
export function GoogleAccount() {
  const [email, setEmail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let alive = true
    api()
      .authStatus()
      .then(
        (s) => alive && setEmail(s.signedIn ? s.email : null),
        () => alive && setEmail(null),
      )
    api()
      .runStatus()
      .then(
        (s) => alive && setRunning(s.running),
        () => alive && setRunning(false),
      )
    return () => {
      alive = false
    }
  }, [])

  const onSignOut = useCallback(() => {
    setBusy(true)
    setError(null)
    api()
      .signOut()
      .then(
        (r) => {
          if (r.ok) setEmail(null)
          else setError(r.error)
        },
        () => setError(GENERIC_ERROR),
      )
      .finally(() => setBusy(false))
  }, [])

  return <GoogleAccountView email={email} error={error} busy={busy} running={running} onSignOut={onSignOut} />
}
