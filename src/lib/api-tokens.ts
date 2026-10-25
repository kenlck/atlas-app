import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from './db'
import { forbidden, HttpError, unauthorized } from './http'
import { newId } from './ids'
import { apiToken, user } from './schema'

export type TokenScope = 'read' | 'read_write'
export type TokenExpiry = '30d' | '90d' | '1y' | 'never'

const EXPIRY_DAYS: Record<Exclude<TokenExpiry, 'never'>, number> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
}
const DAY_MS = 24 * 60 * 60 * 1000

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

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function readBearer(header: string | null) {
  if (!header) return ''
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1] ?? ''
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

function scopeOf(value: unknown): TokenScope {
  if (value === undefined) return 'read'
  if (value === 'read' || value === 'read_write') return value
  throw new HttpError(400, 'Bad request')
}

function expiresAtOf(value: unknown, now: Date): Date | null {
  if (value === undefined || value === '90d') {
    return new Date(now.getTime() + EXPIRY_DAYS['90d'] * DAY_MS)
  }
  if (value === '30d' || value === '1y') {
    return new Date(now.getTime() + EXPIRY_DAYS[value] * DAY_MS)
  }
  if (value === 'never') return null
  throw new HttpError(400, 'Bad request')
}

export async function createApiToken(
  userId: string,
  input: { name?: unknown; scope?: unknown; expiry?: unknown },
): Promise<TokenCreated> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new HttpError(400, 'Name is required')
  if (name.length > 80) throw new HttpError(400, 'Name is too long')
  const scope = scopeOf(input.scope)
  const now = new Date()
  const expiresAt = expiresAtOf(input.expiry, now)

  const token = `atl_${randomBytes(32).toString('base64url')}`
  const row = {
    id: newId(),
    userId,
    name,
    tokenHash: hashToken(token),
    prefix: token.slice(0, 8),
    scope,
    expiresAt,
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
  if (rows.length === 0) unauthorized()
  const row = rows[0]
  if (
    row.revokedAt ||
    (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())
  ) {
    unauthorized()
  }
  const owners = await db
    .select({ mustChangePassword: user.mustChangePassword })
    .from(user)
    .where(eq(user.id, row.userId))
    .limit(1)
  if (!owners[0]) unauthorized()
  if (owners[0].mustChangePassword) forbidden()
  return { userId: row.userId, tokenId: row.id, scope: row.scope }
}

export async function recordTokenUse(tokenId: string) {
  await getDb()
    .update(apiToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiToken.id, tokenId))
}
