import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthShell } from '#/components/AuthShell'
import { authClient } from '#/lib/auth-client'
import { MIN_PASSWORD } from '#/lib/password-policy'
import { fetchSession } from '#/server/fns'

export const Route = createFileRoute('/sign-up')({
  loader: async () => ({ session: await fetchSession() }),
  component: SignUp,
})

type FieldErrors = { name?: string; email?: string; password?: string }

function SignUp() {
  const { session } = Route.useLoaderData()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<FieldErrors>({})
  const [pending, setPending] = useState(false)

  if (session) {
    void navigate({ to: session.user.mustChangePassword ? '/set-password' : '/' })
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const next: FieldErrors = {}
    if (!name.trim()) next.name = 'Enter your name.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = 'Enter a valid email.'
    if (password.length < MIN_PASSWORD) next.password = `Use at least ${MIN_PASSWORD} characters.`
    setFields(next)
    if (next.name || next.email || next.password) return
    setPending(true)
    setError(null)
    const result = await authClient.signUp.email({ name, email, password })
    setPending(false)
    if (result.error) {
      setError(result.error.message || "Couldn't create that account.")
      return
    }
    await navigate({ to: '/' })
  }

  return (
    <AuthShell>
      <h1>Create an account</h1>
      <div className="sub">Start writing in your own space.</div>
      <form noValidate onSubmit={(event) => void submit(event)}>
        {error ? <div className="banner">{error}</div> : null}
        <label htmlFor="name">Name</label>
        <input
          id="name"
          className={fields.name ? 'in bad' : 'in'}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setFields((current) => ({ ...current, name: undefined }))
          }}
          required
        />
        {fields.name ? <div className="err">{fields.name}</div> : null}
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className={fields.email ? 'in bad' : 'in'}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            setFields((current) => ({ ...current, email: undefined }))
          }}
          required
        />
        {fields.email ? <div className="err">{fields.email}</div> : null}
        <label htmlFor="password">Password</label>
        <input
          id="password"
          className={fields.password ? 'in bad' : 'in'}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
            setFields((current) => ({ ...current, password: undefined }))
          }}
          minLength={MIN_PASSWORD}
          required
        />
        {fields.password ? (
          <div className="err">{fields.password}</div>
        ) : (
          <div className="hint">At least {MIN_PASSWORD} characters.</div>
        )}
        <button className="btn" type="submit" disabled={pending}>
          Create account
        </button>
      </form>
      <div className="foot-auth">
        Already have an account? <Link to="/sign-in">Sign in</Link>
      </div>
    </AuthShell>
  )
}
