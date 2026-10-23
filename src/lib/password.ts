import { eq } from 'drizzle-orm'
import { getAuth } from './auth'
import { MIN_PASSWORD } from './password-policy'
import { getDb } from './db'
import { HttpError } from './http'
import { account, user } from './schema'

export { MIN_PASSWORD }

export async function setNewPassword(userId: string, next: string) {
  if (next.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`)
  }
  const db = getDb()
  const rows = await db.select().from(user).where(eq(user.id, userId)).limit(1)
  const current = rows[0]
  if (!current) {
    throw new HttpError(404, 'Not found')
  }
  if (!current.mustChangePassword) {
    throw new HttpError(400, 'Password change is not required')
  }
  const ctx = await getAuth().$context
  const passwordHash = await ctx.password.hash(next)
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(eq(account.userId, userId))
    await tx
      .update(user)
      .set({ mustChangePassword: false, updatedAt: now })
      .where(eq(user.id, userId))
  })
  return { ok: true as const }
}
