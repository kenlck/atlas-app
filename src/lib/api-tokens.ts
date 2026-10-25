import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from './db'
import { forbidden, HttpError, unauthorized } from './http'
import { newId } from './ids'
import { apiToken, user } from './schema'

export type TokenScope = 'read' | 'read_write'
export type TokenExpiry = '30d' | '90d' | '365d' | 'never'

export type TokenPublic = {
  id: string
  name: string
  prefix: string
  scope: TokenScope
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export type TokenCreated = TokenPublic & { token: string }

export type BearerAuth = {
  userId: string
  tokenId: string
  scope: TokenScope
}

const DAY_MS = 24 * 60 * 60 * 1000
const EXPIRY_DAYS: Record<Exclude<TokenExpiry, 'never'>, number> = {
  '30d': 30,
  '90d': 90,
  '365d': 365,
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function readBearer(header: string | null) {
  if (!header) return ''
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1] ?? ''
}

function isExpiry(value: string): value is TokenExpiry {
  return (
    value === '30d' || value === '90d' || value === '365d' || value === 'never'
  )
}

function isScope(value: string): value is TokenScope {
  return value === 'read' || value === 'read_write'
}

function expiresAtFor(choice: TokenExpiry, now: Date) {
  if (choice === 'never') return null
  return new Date(now.getTime() + EXPIRY_DAYS[choice] * DAY_MS)
}

function toPublic(row: {
  id: string
  name: string
  prefix: string
  scope: TokenScope
  expiresAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
}): TokenPublic {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function createApiToken(
  userId: string,
  input: { name?: unknown; scope?: unknown; expiresIn?: unknown },
): Promise<TokenCreated> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new HttpError(400, 'Name is required')
  if (name.length > 80) throw new HttpError(400, 'Name is too long')
  const scope = input.scope === undefined ? 'read' : input.scope
  if (typeof scope !== 'string' || !isScope(scope)) {
    throw new HttpError(400, 'Bad request')
  }
  const expiresIn = input.expiresIn === undefined ? '90d' : input.expiresIn
  if (typeof expiresIn !== 'string' || !isExpiry(expiresIn)) {
    throw new HttpError(400, 'Bad request')
  }

  const token = `atl_${randomBytes(32).toString('base64url')}`
  const now = new Date()
  const row = {
    id: newId(),
    userId,
    name,
    tokenHash: hashToken(token),
    prefix: token.slice(0, 8),
    scope,
    expiresAt: expiresAtFor(expiresIn, now),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
  }
  await getDb().insert(apiToken).values(row)
  return { ...toPublic(row), token }
}

export async function listApiTokens(userId: string): Promise<TokenPublic[]> {
  const rows = await getDb()
    .select({
      id: apiToken.id,
      name: apiToken.name,
      prefix: apiToken.prefix,
      scope: apiToken.scope,
      expiresAt: apiToken.expiresAt,
      lastUsedAt: apiToken.lastUsedAt,
      createdAt: apiToken.createdAt,
    })
    .from(apiToken)
    .where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)))
    .orderBy(desc(apiToken.createdAt))
  return rows.map(toPublic)
}

export async function revokeApiToken(userId: string, tokenId: string) {
  const updated = await getDb()
    .update(apiToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiToken.id, tokenId),
        eq(apiToken.userId, userId),
        isNull(apiToken.revokedAt),
      ),
    )
    .returning({ id: apiToken.id })
  if (updated.length === 0) throw new HttpError(404, 'Not found')
  return { ok: true as const }
}

function expired(expiresAt: Date | null) {
  return Boolean(expiresAt && expiresAt.getTime() <= Date.now())
}

export async function authenticateBearer(
  authorization: string | null,
): Promise<BearerAuth> {
  const token = readBearer(authorization)
  if (!token) unauthorized()
  const db = getDb()
  const rows = await db
    .select({
      id: apiToken.id,
      userId: apiToken.userId,
      scope: apiToken.scope,
      expiresAt: apiToken.expiresAt,
      revokedAt: apiToken.revokedAt,
    })
    .from(apiToken)
    .where(eq(apiToken.tokenHash, hashToken(token)))
    .limit(1)
  const row = rows[0]
  if (!row || row.revokedAt || expired(row.expiresAt)) unauthorized()
  const owners = await db
    .select({ mustChangePassword: user.mustChangePassword })
    .from(user)
    .where(eq(user.id, row.userId))
    .limit(1)
  if (!owners[0]) unauthorized()
  if (owners[0].mustChangePassword) forbidden()
  await db
    .update(apiToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiToken.id, row.id))
  return { userId: row.userId, tokenId: row.id, scope: row.scope }
}
