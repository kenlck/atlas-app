import { getRequestHeaders } from '@tanstack/react-start/server'
import { getAuth } from './auth'
import { assertApiSession } from './gate'
import { unauthorized } from './http'

export async function readSession() {
  const auth = getAuth()
  return auth.api.getSession({ headers: getRequestHeaders() })
}

export async function requireSession() {
  const session = await readSession()
  if (!session) unauthorized()
  return session
}

export async function requireUnlockedSession() {
  const session = await requireSession()
  const extra = session.user as { mustChangePassword?: boolean }
  assertApiSession({
    hasSession: true,
    mustChangePassword: Boolean(extra.mustChangePassword),
  })
  return session
}
