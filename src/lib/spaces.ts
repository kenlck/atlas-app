import { and, eq, sql } from 'drizzle-orm'
import { assertAccess } from './access'
import { getDb } from './db'
import { HttpError } from './http'
import { getPersonalSpace } from './pages'
import { user } from './schema'
import type { Space } from './schema'

export async function touchLastSpace(userId: string, spaceId: string) {
  const db = getDb()
  await db
    .update(user)
    .set({ lastSpaceId: spaceId })
    .where(
      and(
        eq(user.id, userId),
        sql`${user.lastSpaceId} is distinct from ${spaceId}`,
      ),
    )
}

export async function getDefaultSpace(userId: string): Promise<Space> {
  const db = getDb()
  const rows = await db
    .select({ lastSpaceId: user.lastSpaceId })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  const lastSpaceId = rows[0]?.lastSpaceId
  if (lastSpaceId) {
    try {
      const access = await assertAccess(userId, { spaceId: lastSpaceId })
      return access.space
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error
    }
  }
  return getPersonalSpace(userId)
}
