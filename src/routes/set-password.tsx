import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthShell } from '#/components/AuthShell'
import { authClient } from '#/lib/auth-client'
import { MIN_PASSWORD } from '#/lib/password-policy'
import { changePasswordFn, fetchSession } from '#/server/fns'

export const Route = createFileRoute('/set-password')({
  loader: async () => {
    const session = await fetchSession()
    if (!session) {
      throw redirect({ to: '/sign-in' })
    }
    if (!session.user.mustChangePassword) {
      throw redirect({ to: '/' })
    }
    return { session }
  },
  component: SetPassword,
})

function SetPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (password !== confirm) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    setPending(true)
    setError(null)
    try {
      await changePasswordFn({ data: { password } })
      await navigate({ to: '/' })
    } catch {
      setError("Couldn't save that password.")
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthShell>
      <h1>Set a new password</h1>
      <div className="sub">Your password was reset. Choose a new one to continue.</div>
      <form onSubmit={(event) => void submit(event)}>
        {error ? <div className="banner">{error}</div> : null}
        <label htmlFor="password">New password</label>
        <input
          id="password"
          className="in"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={MIN_PASSWORD}
          required
        />
        <div className="hint">At least {MIN_PASSWORD} characters.</div>
        <label htmlFor="confirm">Confirm new password</label>
        <input
          id="confirm"
          className={mismatch ? 'in bad' : 'in'}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value)
            setMismatch(false)
          }}
          required
        />
        {mismatch ? <div className="err">Passwords don't match.</div> : null}
        <button className="btn" type="submit" disabled={pending}>
          Save password
        </button>
      </form>
      <div className="foot-auth">
        <button
          type="button"
          className="ghost"
          style={{ border: 0, color: 'var(--accent)', background: 'transparent', cursor: 'pointer' }}
          onClick={() =>
            authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign('/sign-in') } })
          }
        >
          Sign out
        </button>
      </div>
    </AuthShell>
  )
}
