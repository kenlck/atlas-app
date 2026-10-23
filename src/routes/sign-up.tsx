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

function SignUp() {
  const { session } = Route.useLoaderData()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  if (session) {
    void navigate({ to: session.user.mustChangePassword ? '/set-password' : '/' })
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
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
      <form onSubmit={(event) => void submit(event)}>
        {error ? <div className="banner">{error}</div> : null}
        <label htmlFor="name">Name</label>
        <input
          id="name"
          className="in"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="in"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <label htmlFor="password">Password</label>
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
