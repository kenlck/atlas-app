import { eq, sql } from 'drizzle-orm'
import { closeDb, getDb } from '../src/lib/db.ts'
import { HttpError } from '../src/lib/http.ts'
import { createPage, movePage, targetIsSelfOrDescendant } from '../src/lib/pages.ts'
import { page } from '../src/lib/schema.ts'
import { createUser } from '../tests/helpers.ts'
import { assertLocalDatabaseUrl } from './verify-local.ts'

const WALK_MS = 500

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function useLocalDatabase() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) fail('DATABASE_URL or TEST_DATABASE_URL is required')
  assertLocalDatabaseUrl(url)
  process.env.DATABASE_URL = url
}

async function parentKey(spaceId: string) {
  const rows = await getDb()
    .select({ title: page.title, parentId: page.parentId })
    .from(page)
    .where(eq(page.spaceId, spaceId))
  const byTitle = new Map(rows.map((row) => [row.title, row.parentId]))
  return ['A', 'B', 'C'].map((title) => byTitle.get(title) ?? null)
}

async function expectRefusal(userId: string, pageId: string, parentId: string) {
  try {
    await movePage(userId, { pageId, parentId })
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === 400 &&
      error.message === 'Cannot move a page under itself or a descendant'
    ) {
      return
    }
    fail(error instanceof Error ? error.message.split('\n')[0] : 'move failed')
  }
  fail('move was written')
}

async function main() {
  useLocalDatabase()
  const owner = await createUser('Move Cycle')
  const spaceId = owner.space.id
  const userId = owner.user.id
  const a = await createPage(userId, { spaceId, title: 'A' })
  const b = await createPage(userId, { spaceId, parentId: a.id, title: 'B' })
  const c = await createPage(userId, { spaceId, parentId: b.id, title: 'C' })
  const before = await parentKey(spaceId)
  if (before[0] !== null || before[1] !== a.id || before[2] !== b.id) {
    fail('tree was not A > B > C')
  }

  await expectRefusal(userId, a.id, c.id)
  const afterGrandchild = JSON.stringify(await parentKey(spaceId))
  const unchanged = afterGrandchild === JSON.stringify(before)
  console.log('grandchild_status=400')
  console.log('grandchild_error_clear=true')
  console.log(`parents_unchanged=${unchanged}`)
  if (!unchanged) fail('grandchild move wrote')

  await expectRefusal(userId, a.id, a.id)
  const afterSelf =
    JSON.stringify(await parentKey(spaceId)) === JSON.stringify(before)
  console.log('self_status=400')
  console.log('self_error_clear=true')
  console.log(`self_unchanged=${afterSelf}`)
  if (!afterSelf) fail('self move wrote')

  const moved = await movePage(userId, { pageId: c.id, parentId: a.id })
  const afterValid = await parentKey(spaceId)
  const validUpdated =
    moved.parentId === a.id &&
    afterValid[0] === null &&
    afterValid[1] === a.id &&
    afterValid[2] === a.id
  console.log('valid_status=200')
  console.log(`valid_parent_updated=${validUpdated}`)
  if (!validUpdated) fail('legal move was blocked')

  // Skip movePage. A cyclic page is hidden as not-found before the CTE runs.
  await getDb().execute(
    sql`update page set parent_id = ${c.id} where id = ${a.id}`,
  )
  const cycled = await parentKey(spaceId)
  if (cycled[0] !== c.id || cycled[1] !== a.id || cycled[2] !== a.id) {
    fail('cycle was not written')
  }
  const outside = await createPage(userId, { spaceId, title: 'D' })
  const started = Date.now()
  const outcome = await Promise.race([
    getDb()
      .transaction(async (tx) => {
        const hit = await targetIsSelfOrDescendant(tx, a.id, outside.id)
        return { kind: 'ok' as const, hit }
      })
      .then(
        (value) => value,
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), WALK_MS)
    }),
  ])
  const ms = Date.now() - started
  const message =
    outcome.kind === 'error' && outcome.error instanceof Error
      ? outcome.error.message
      : ''
  const statementTimeout = /statement timeout/i.test(message)
  const within =
    outcome.kind === 'ok' &&
    outcome.hit === false &&
    ms <= WALK_MS &&
    !statementTimeout
  console.log(`cycle_walk_ms=${ms}`)
  console.log(`cycle_walk_within_500ms=${within}`)
  console.log(`statement_timeout=${statementTimeout}`)
  if (!within) fail('descendant walk did not return within 500ms')
  await closeDb()
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message.split('\n')[0] : 'move-cycle failed',
  )
  process.exit(1)
})
