import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { handleResetPassword, resetAdminRateLimit } from '../src/lib/admin-reset'
import { getDb } from '../src/lib/db'
import { assertApiSession } from '../src/lib/gate'
import { HttpError } from '../src/lib/http'
import { setNewPassword } from '../src/lib/password'
import { adminAudit, session, user } from '../src/lib/schema'
import { createUser } from './helpers'

const LOCAL_SECRET = 'test-admin-api-secret-32-chars-minx'

function request(secret: string | null, email: string, ip = '203.0.113.10') {
  const headers = new Headers({ 'content-type': 'application/json', 'x-forwarded-for': ip })
  if (secret !== null) {
    headers.set('authorization', `Bearer ${secret}`)
  }
  return new Request('http://atlas.test/api/admin/reset-password', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email }),
  })
}

describe('admin reset', () => {
  afterEach(() => {
    process.env.ADMIN_API_SECRET = LOCAL_SECRET
    resetAdminRateLimit()
  })

  it('returns 404 when the secret is missing or short', async () => {
    delete process.env.ADMIN_API_SECRET
    expect((await handleResetPassword(request(LOCAL_SECRET, 'a@b.c'))).status).toBe(404)
    process.env.ADMIN_API_SECRET = 'short-secret'
    expect((await handleResetPassword(request('short-secret', 'a@b.c'))).status).toBe(404)
  })

  it('rejects a wrong secret, returns a temp password once, locks the user, and audits', async () => {
    process.env.ADMIN_API_SECRET = LOCAL_SECRET
    const person = await createUser('Reset Me')

    const wrong = await handleResetPassword(request('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', person.user.email))
    expect(wrong.status).toBe(401)

    const ok = await handleResetPassword(request(LOCAL_SECRET, person.user.email))
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { temporaryPassword: string }
    expect(typeof body.temporaryPassword).toBe('string')
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(8)

    const db = getDb()
    const rows = await db.select().from(user).where(eq(user.id, person.user.id))
    expect(rows[0]?.mustChangePassword).toBe(true)
    const sessions = await db.select().from(session).where(eq(session.userId, person.user.id))
    expect(sessions).toHaveLength(0)
    const audits = await db.select().from(adminAudit).where(eq(adminAudit.targetUserId, person.user.id))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.action).toBe('reset_password')
    expect(JSON.stringify(audits[0])).not.toContain(LOCAL_SECRET)
    expect(JSON.stringify(audits[0])).not.toContain(body.temporaryPassword)

    expect(() =>
      assertApiSession({ hasSession: true, mustChangePassword: true }),
    ).toThrow(HttpError)
    try {
      assertApiSession({ hasSession: true, mustChangePassword: true })
    } catch (error) {
      expect((error as HttpError).status).toBe(403)
    }

    await setNewPassword(person.user.id, 'new-password-ok')
    const unlocked = await db.select().from(user).where(eq(user.id, person.user.id))
    expect(unlocked[0]?.mustChangePassword).toBe(false)
  })

  it('rate limits the endpoint', async () => {
    process.env.ADMIN_API_SECRET = LOCAL_SECRET
    const ip = '198.51.100.20'
    let last = 200
    for (let i = 0; i < 6; i += 1) {
      last = (await handleResetPassword(request(LOCAL_SECRET, `missing${i}@example.com`, ip))).status
    }
    expect(last).toBe(429)
  })
})
