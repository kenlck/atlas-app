import { Link, createFileRoute } from '@tanstack/react-router'
import { AuthShell } from '#/components/AuthShell'

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPassword,
})

function ForgotPassword() {
  return (
    <AuthShell>
      <h1>Forgot your password?</h1>
      <div className="note">
        Atlas doesn't send reset emails. Ask whoever runs your Atlas to reset it. They'll
        give you a temporary password, and you'll set a new one when you sign in.
      </div>
      <div className="foot-auth" style={{ textAlign: 'left' }}>
        <Link to="/sign-in">← Back to sign in</Link>
      </div>
    </AuthShell>
  )
}
