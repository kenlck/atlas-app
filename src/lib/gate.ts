import { forbidden, unauthorized } from './http'

export function assertApiSession(input: {
  hasSession: boolean
  mustChangePassword: boolean
}) {
  if (!input.hasSession) unauthorized()
  if (input.mustChangePassword) forbidden()
}

export function lockedAuthPathAllowed(pathname: string) {
  const rest = pathname.replace(/\/+$/, '').split('/api/auth/')[1] ?? ''
  return rest === 'get-session' || rest === 'sign-out' || rest === 'change-password'
}
