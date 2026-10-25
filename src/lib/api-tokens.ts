import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from './db'
import { forbidden, HttpError, unauthorized } from './http'
import { newId } from './ids'
import { apiToken, user } from './schema'

export type TokenPublic = {
  id: string
  name: string
  prefix: string
  lastUsedAt: string | null
  createdAt: string
}

export type TokenCreated = TokenPublic & { token: string }

export type BearerAuth = {
  userId: string
  tokenId: string
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
  lastUsedAt: Date | null
  createdAt: Date
}): TokenPublic {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function createApiToken(
  userId: string,
  input: { name?: unknown },
): Promise<TokenCreated> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new HttpError(400, 'Name is required')
  if (name.length > 80) throw new HttpError(400, 'Name is too long')

  const token = `atl_${randomBytes(32).toString('base64url')}`
  const now = new Date()
  const row = {
    id: newId(),
    userId,
    name,
    tokenHash: hashToken(token),
    prefix: token.slice(0, 8),
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
      revokedAt: apiToken.revokedAt,
    })
    .from(apiToken)
    .where(eq(apiToken.tokenHash, hashToken(token)))
    .limit(1)
  const row = rows[0]
  if (!row || row.revokedAt) unauthorized()
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
  return { userId: row.userId, tokenId: row.id }
}
