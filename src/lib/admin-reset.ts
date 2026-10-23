import { hashPassword, generateRandomString, constantTimeEqual } from 'better-auth/crypto'
import { and, eq } from 'drizzle-orm'
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

function allowRequest(ip: string) {
  const now = Date.now()
  const current = hits.get(ip) ?? { times: [] }
  current.times = current.times.filter((time) => now - time < RATE_WINDOW_MS)
  if (current.times.length === 0) {
    hits.delete(ip)
  }
  if (current.times.length >= RATE_MAX) {
    hits.set(ip, current)
    return false
  }
  current.times.push(now)
  hits.set(ip, current)
  return true
}

function trustProxyEnabled() {
  const value = process.env.TRUST_PROXY?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function adminCallerIp(request: Request, socketIp?: string | null) {
  if (trustProxyEnabled()) {
    const parts = (request.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    const picked = parts[parts.length - 1]
    if (picked) return picked
  }
  return socketIp || 'unknown'
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
  if (!allowRequest(ip)) {
    return json({ error: 'Too many requests' }, 429)
  }

  const token = bearerToken(request)
  if (!constantTimeEqual(token, secret)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  let email = ''
  try {
    const body = (await request.json()) as { email?: unknown }
    if (typeof body.email === 'string') {
      email = body.email.trim().toLowerCase()
    }
  } catch {
    return json({ error: 'Bad request' }, 400)
  }
  if (!email) {
    return json({ error: 'Bad request' }, 400)
  }

  const db = getDb()
  const users = await db.select().from(user).where(eq(user.email, email)).limit(1)
  const target = users[0]
  if (!target) {
    return json({ error: 'Not found' }, 404)
  }

  const temporaryPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9')
  const passwordHash = await hashPassword(temporaryPassword)
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
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
