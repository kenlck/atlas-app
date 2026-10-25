import { hashPassword, generateRandomString, constantTimeEqual } from 'better-auth/crypto'
import { and, eq } from 'drizzle-orm'
import { resolveClientIp } from './client-ip'
import { getDb } from './db'
import { newId } from './ids'
import { account, adminAudit, session, user } from './schema'

const RATE_WINDOW_MS = 15 * 60 * 1000
const RATE_MAX = 5

type Hit = { times: number[] }
const hits = new Map<string, Hit>()

export function resetAdminRateLimit() {
  hits.clear()
}

function pruneFailures(ip: string) {
  const now = Date.now()
  const current = hits.get(ip) ?? { times: [] }
  current.times = current.times.filter((time) => now - time < RATE_WINDOW_MS)
  if (current.times.length === 0) {
    hits.delete(ip)
    return { times: [] as number[] }
  }
  hits.set(ip, current)
  return current
}

function overFailureLimit(ip: string) {
  return pruneFailures(ip).times.length >= RATE_MAX
}

function recordFailure(ip: string) {
  const current = pruneFailures(ip)
  current.times.push(Date.now())
  hits.set(ip, current)
}

export function adminCallerIp(request: Request, socketIp?: string | null) {
  return resolveClientIp(request, socketIp)
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bearerToken(request: Request) {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) {
    return ''
  }
  return header.slice('Bearer '.length)
}

function configuredSecret() {
  const secret = process.env.ADMIN_API_SECRET
  if (!secret || secret.length < 32) {
    return null
  }
  return secret
}

export async function handleResetPassword(
  request: Request,
  fallbackIp?: string | null,
): Promise<Response> {
  const secret = configuredSecret()
  if (!secret) {
    return new Response(null, { status: 404 })
  }

  const ip = adminCallerIp(request, fallbackIp)
  const token = bearerToken(request)
  // Compare the bearer before touching the limiter. A bad token from another
  // address cannot fill this IP's bucket, and a success does not count.
  if (!constantTimeEqual(token, secret)) {
    if (overFailureLimit(ip)) return json({ error: 'Too many requests' }, 429)
    recordFailure(ip)
    return json({ error: 'Unauthorized' }, 401)
  }
  if (overFailureLimit(ip)) return json({ error: 'Too many requests' }, 429)

  let email = ''
  try {
    const body = (await request.json()) as { email?: unknown }
    if (typeof body.email === 'string') {
      email = body.email.trim().toLowerCase()
    }
  } catch {
    recordFailure(ip)
    return json({ error: 'Bad request' }, 400)
  }
  if (!email) {
    recordFailure(ip)
    return json({ error: 'Bad request' }, 400)
  }

  const db = getDb()
  const users = await db.select().from(user).where(eq(user.email, email)).limit(1)
  const target = users[0]
  if (!target) {
    recordFailure(ip)
    return json({ error: 'Not found' }, 404)
  }

  const temporaryPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9')
  const passwordHash = await hashPassword(temporaryPassword)
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx
      .update(account)
      .set({ password: passwordHash })
      .where(and(eq(account.userId, target.id), eq(account.providerId, 'credential')))
    await tx
      .update(user)
      .set({ mustChangePassword: true })
      .where(eq(user.id, target.id))
    await tx.delete(session).where(eq(session.userId, target.id))
    await tx.insert(adminAudit).values({
      id: newId(),
      action: 'reset_password',
      targetUserId: target.id,
      callerIp: ip,
      createdAt: now,
    })
  })

  return json({ temporaryPassword }, 200)
}

export const ADMIN_RESET_RATE = { windowMs: RATE_WINDOW_MS, max: RATE_MAX }
