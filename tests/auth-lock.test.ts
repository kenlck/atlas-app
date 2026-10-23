import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { handleResetPassword, resetAdminRateLimit } from '../src/lib/admin-reset'
import { handleAuthRequest } from '../src/lib/auth-guard'
import { getDb } from '../src/lib/db'
import { lockedAuthPathAllowed } from '../src/lib/gate'
import { user } from '../src/lib/schema'
import { createUser } from './helpers'

const LOCAL_SECRET = 'test-admin-api-secret-32-chars-minx'
const SOCKET_IP = '203.0.113.10'
const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:3000'

function resetRequest(email: string) {
  return new Request('http://atlas.test/api/admin/reset-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LOCAL_SECRET}`,
    },
    body: JSON.stringify({ email }),
  })
}

function cookiesFrom(response: Response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
  return raw
    .filter(Boolean)
    .map((entry) => entry.split(';')[0] ?? '')
    .filter(Boolean)
    .join('; ')
}

describe('locked auth allowlist', () => {
  afterEach(() => {
    process.env.ADMIN_API_SECRET = LOCAL_SECRET
    resetAdminRateLimit()
  })

  it('allows get-session, sign-out and change-password only', () => {
    expect(lockedAuthPathAllowed('/api/auth/get-session')).toBe(true)
    expect(lockedAuthPathAllowed('/api/auth/sign-out')).toBe(true)
    expect(lockedAuthPathAllowed('/api/auth/change-password')).toBe(true)
    expect(lockedAuthPathAllowed('/api/auth/update-user')).toBe(false)
    expect(lockedAuthPathAllowed('/api/auth/list-sessions')).toBe(false)
    expect(lockedAuthPathAllowed('/api/auth/list-accounts')).toBe(false)
  })

  it('returns 403 from update-user while locked and leaves the name unchanged', async () => {
    process.env.ADMIN_API_SECRET = LOCAL_SECRET
    const person = await createUser('Lock Name')
    const reset = await handleResetPassword(resetRequest(person.user.email), SOCKET_IP)
    expect(reset.status).toBe(200)
    const body = (await reset.json()) as { temporaryPassword: string }

    const signIn = await handleAuthRequest(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: person.user.email, password: body.temporaryPassword }),
      }),
    )
    expect(signIn.status).toBe(200)
    const cookie = cookiesFrom(signIn)
    expect(cookie.length).toBeGreaterThan(0)

    const update = await handleAuthRequest(
      new Request(`${ORIGIN}/api/auth/update-user`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie,
        },
        body: JSON.stringify({ name: 'Renamed while locked' }),
      }),
    )
    expect(update.status).toBe(403)

    const session = await handleAuthRequest(
      new Request(`${ORIGIN}/api/auth/get-session`, {
        method: 'GET',
        headers: { origin: ORIGIN, cookie },
      }),
    )
    expect(session.status).toBe(200)
    const sessionBody = await session.text()
    expect(sessionBody).not.toContain('Renamed while locked')

    const rows = await getDb().select().from(user).where(eq(user.id, person.user.id))
    expect(rows[0]?.name).toBe('Lock Name')
    expect(rows[0]?.mustChangePassword).toBe(true)
  })
})
