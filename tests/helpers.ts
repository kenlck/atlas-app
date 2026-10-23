import { getAuth } from '../src/lib/auth'
import { getDb } from '../src/lib/db'
import { space } from '../src/lib/schema'
import { and, eq } from 'drizzle-orm'

let seq = 0

export async function createUser(name = 'Test User') {
  seq += 1
  const email = `user${seq}-${Date.now()}@example.com`
  const password = 'correct-horse-battery'
  const result = await getAuth().api.signUpEmail({
    body: { name, email, password },
  })
  if (!result.user) {
    throw new Error('sign-up failed')
  }
  const db = getDb()
  const spaces = await db
    .select()
    .from(space)
    .where(and(eq(space.kind, 'personal'), eq(space.ownerUserId, result.user.id)))
    .limit(1)
  if (!spaces[0]) {
    throw new Error('personal space missing')
  }
  return { user: result.user, password, space: spaces[0] }
}
