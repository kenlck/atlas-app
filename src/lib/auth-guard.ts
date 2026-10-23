import { eq } from 'drizzle-orm'
import { getAuth } from './auth'
import { getDb } from './db'
import { lockedAuthPathAllowed } from './gate'
import { user } from './schema'

async function sessionIsLocked(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers })
  if (!session) return false
  const extra = session.user as { mustChangePassword?: boolean }
  if (extra.mustChangePassword) return true
  const rows = await getDb()
    .select({ mustChangePassword: user.mustChangePassword })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1)
  return Boolean(rows[0]?.mustChangePassword)
}

export async function handleAuthRequest(request: Request) {
  if (await sessionIsLocked(request)) {
    const path = new URL(request.url).pathname
    if (!lockedAuthPathAllowed(path)) {
      return new Response(JSON.stringify({ message: 'Password change required' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
  return getAuth().handler(request)
}
