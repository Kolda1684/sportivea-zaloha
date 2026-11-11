import { APP_TITLE, READ_ONLY_NOTE, SIGN_IN_BUTTON, SIGN_IN_TIPS, SIGN_OUT_BUTTON, SIGN_OUT_DISABLED_HINT } from '../strings'

type SignInProps = {
  busy: boolean
  error: string | null
  onSignIn(): void
}

export function SignIn({ busy, error, onSignIn }: SignInProps) {
  return (
    <section className="hero">
      <h1>{APP_TITLE}</h1>
      <p className="lead">{READ_ONLY_NOTE}</p>
      <button type="button" className="primary big" disabled={busy} onClick={onSignIn}>
        {SIGN_IN_BUTTON}
      </button>
      <p className="muted small">{SIGN_IN_TIPS}</p>
      {error !== null && (
        <p className="callout bad" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

type AccountBarProps = {
  email: string
  /** A download is running (or starting): signing out is disabled. */
  running: boolean
  onSignOut(): void
}

/** Header part for a signed-in user. */
export function AccountBar({ email, running, onSignOut }: AccountBarProps) {
  return (
    <div className="account">
      <span className="muted small account-email">{email}</span>
      <button type="button" className="link" disabled={running} title={running ? SIGN_OUT_DISABLED_HINT : undefined} onClick={onSignOut}>
        {SIGN_OUT_BUTTON}
      </button>
    </div>
  )
}
