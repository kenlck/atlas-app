import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../src/lib/db'
import { HttpError } from '../src/lib/http'
import { createPage, savePage } from '../src/lib/pages'
import { page as pageTable } from '../src/lib/schema'
import {
  acceptInvite,
  createInvite,
  createTeam,
  deleteTeam,
} from '../src/lib/teams'
import { testDatabaseUrl } from './db-url'
import { createUser } from './helpers'

function outcomeCode(error: unknown) {
  const sql = pgCode(error)
  if (sql) return sql
  if (error instanceof HttpError) return `http${error.status}`
  return 'error'
}

function pgCode(error: unknown) {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return ''
}

async function lockWaits(watch: ReturnType<typeof postgres>, like: string) {
  const rows = await watch<{ n: number }[]>`
    select count(*)::int as n
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
      and state = 'active'
      and wait_event_type = 'Lock'
      and query like ${like}
  `
  return Number(rows[0]?.n ?? 0)
}

async function waitForLocks(
  watch: ReturnType<typeof postgres>,
  like: string,
  minimum = 1,
) {
  const deadline = Date.now() + 4000
  let waiting = 0
  while (Date.now() < deadline) {
    waiting = await lockWaits(watch, like)
    if (waiting >= minimum) return waiting
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return waiting
}

async function deleteRaceOnce() {
  const owner = await createUser('Owner')
  const created = await createTeam(owner.user.id, 'Delete race')
  const made = await createPage(owner.user.id, {
    spaceId: created.spaceId,
    title: 'Notes',
  })
  const gate = postgres(testDatabaseUrl(), { max: 1 })
  const watch = postgres(testDatabaseUrl(), { max: 1 })
  let save: Promise<unknown> = Promise.resolve()
  let wipe: Promise<unknown> = Promise.resolve()
  let committed = false
  try {
    await gate.unsafe('begin')
    await gate`select id from page where id = ${made.id} for update`
    save = savePage(owner.user.id, {
      pageId: made.id,
      title: 'Saved',
      body: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const saveWaiting = await waitForLocks(watch, 'select "id", "space_id"%')
    if (saveWaiting < 1) return 'save-not-waiting'
    wipe = deleteTeam(owner.user.id, created.id)
    const deleteWaiting = await waitForLocks(watch, 'delete from "team"%')
    if (deleteWaiting < 1) return 'delete-not-waiting'
    await gate.unsafe('commit')
    committed = true
    const results = await Promise.race([
      Promise.allSettled([save, wipe]),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 4000),
      ),
    ])
    if (results === 'timeout') return 'timeout'
    return results
      .map((item) => {
        if (item.status === 'fulfilled') return 'ok'
        return outcomeCode(item.reason)
      })
      .join(',')
  } finally {
    if (!committed) await gate.unsafe('rollback').catch(() => undefined)
    await gate.end({ timeout: 1 }).catch(() => undefined)
    await watch.end({ timeout: 1 }).catch(() => undefined)
    await Promise.allSettled([save, wipe])
  }
}

describe('save races', () => {
  it('does not deadlock a save against deleting the team', async () => {
    const attempts = []
    for (let i = 0; i < 3; i += 1) attempts.push(await deleteRaceOnce())
    expect(attempts.join(' | ')).toMatch(
      /^(ok|http404),ok( \| (ok|http404),ok)*$/,
    )
  })

  it('finishes ten concurrent saves that mention a teammate', async () => {
    const owner = await createUser('Ada')
    const teammate = await createUser('Bea')
    const created = await createTeam(owner.user.id, 'Mentions')
    await acceptInvite(
      teammate.user.id,
      (await createInvite(owner.user.id, created.id, teammate.user.id)).id,
    )
    const made = await createPage(owner.user.id, {
      spaceId: created.spaceId,
      title: 'Notes',
    })
    const body = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: teammate.user.id, label: 'x' } },
            { type: 'text', text: ' hi' },
          ],
        },
      ],
    }
    const gate = postgres(testDatabaseUrl(), { max: 1 })
    const watch = postgres(testDatabaseUrl(), { max: 1 })
    let pending: Promise<unknown>[] = []
    let committed = false
    let finished = false
    try {
      await gate.unsafe('begin')
      await gate`select id from page where id = ${made.id} for update`
      pending = Array.from({ length: 10 }, () =>
        savePage(owner.user.id, { pageId: made.id, title: 'Notes', body }),
      )
      const waiting = await waitForLocks(watch, 'select "id", "space_id"%', 9)
      expect(waiting).toBeGreaterThanOrEqual(9)
      await gate.unsafe('commit')
      committed = true
      const outcome = await Promise.race([
        Promise.all(pending).then(() => 'done' as const),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 4000),
        ),
      ])
      expect(outcome).toBe('done')
      finished = true
      const stored = await getDb()
        .select({ bodyText: pageTable.bodyText })
        .from(pageTable)
        .where(eq(pageTable.id, made.id))
      expect(stored[0]?.bodyText.includes(teammate.user.name)).toBe(true)
    } finally {
      if (!committed) await gate.unsafe('rollback').catch(() => undefined)
      await gate.end({ timeout: 1 }).catch(() => undefined)
      await watch.end({ timeout: 1 }).catch(() => undefined)
      if (!finished) await closeDb()
    }
  })
})
