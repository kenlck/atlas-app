import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthShell } from '#/components/AuthShell'
import { authClient } from '#/lib/auth-client'
import { fetchSession } from '#/server/fns'

export const Route = createFileRoute('/sign-in')({
  loader: async () => {
    const session = await fetchSession()
    return { session }
  },
  component: SignIn,
})

function SignIn() {
  const { session } = Route.useLoaderData()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  if (session?.user.mustChangePassword) {
    void navigate({ to: '/set-password' })
  } else if (session) {
    void navigate({ to: '/' })
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await authClient.signIn.email({ email, password })
    setPending(false)
    if (result.error) {
      setError('Email or password is incorrect.')
      return
    }
    if (result.data.user.mustChangePassword) {
      await navigate({ to: '/set-password' })
      return
    }
    await navigate({ to: '/' })
  }

  return (
    <AuthShell>
      <h1>Sign in</h1>
      <div className="sub">Welcome back.</div>
      <form onSubmit={(event) => void submit(event)}>
        {error ? <div className="banner">{error}</div> : null}
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
        <div className="row">
          <label htmlFor="password">Password</label>
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
        <input
          id="password"
          className="in"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <button className="btn" type="submit" disabled={pending}>
          Sign in
        </button>
      </form>
      <div className="foot-auth">
        New to Atlas? <Link to="/sign-up">Create an account</Link>
      </div>
    </AuthShell>
  )
}
