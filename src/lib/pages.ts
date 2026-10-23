import { and, eq, isNull, max, sql } from 'drizzle-orm'
import { assertAccess } from './access'
import { emptyDoc, tiptapToText, type Json } from './body-text'
import { getDb } from './db'
import { HttpError, notFound } from './http'
import { newId } from './ids'
import { peopleForBody, type MentionPerson } from './mentions'
import { page, space, user, type Page } from './schema'

export type TreeNode = {
  id: string
  title: string
  parentId: string | null
  position: number
  children: TreeNode[]
}

export type PageView = {
  id: string
  spaceId: string
  parentId: string | null
  title: string
  body: Json
  position: number
  updatedAt: string
  updatedByName: string
  breadcrumbs: Array<{ id: string; title: string }>
  people: MentionPerson[]
}

function asTree(rows: Page[]): TreeNode[] {
  const visible = rows.filter((row) => !row.archivedAt)
  const byParent = new Map<string | null, Page[]>()
  for (const row of visible) {
    const key = row.parentId
    const list = byParent.get(key) ?? []
    list.push(row)
    byParent.set(key, list)
  }
  const walk = (parentId: string | null): TreeNode[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
      .map((row) => ({
        id: row.id,
        title: row.title,
        parentId: row.parentId,
        position: row.position,
        children: walk(row.id),
      }))
  return walk(null)
}

async function nextPosition(spaceId: string, parentId: string | null) {
  const db = getDb()
  const siblingFilter = parentId
    ? and(eq(page.spaceId, spaceId), eq(page.parentId, parentId))
    : and(eq(page.spaceId, spaceId), isNull(page.parentId))
  const rows = await db
    .select({ value: max(page.position) })
    .from(page)
    .where(siblingFilter)
  return (rows[0]?.value ?? 0) + 1000
}

async function loadPageRow(pageId: string) {
  const db = getDb()
  const rows = await db.select().from(page).where(eq(page.id, pageId)).limit(1)
  return rows[0] ?? null
}

type MoveTx = {
  execute: (query: ReturnType<typeof sql>) => unknown
}

async function lockSpaces(tx: MoveTx, spaceIds: string[]) {
  const unique = [...new Set(spaceIds)].sort()
  for (const spaceId of unique) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${spaceId}))`)
  }
}

function executeHasRow(result: unknown) {
  if (Array.isArray(result)) return result.length > 0
  if (result && typeof result === 'object' && 'count' in result) {
    const count = (result as { count?: unknown }).count
    return typeof count === 'number' && count > 0
  }
  return false
}

async function targetIsSelfOrDescendant(
  tx: MoveTx,
  pageId: string,
  parentId: string,
) {
  const result = await tx.execute(sql`
    with recursive descendants as (
      select id from page where id = ${pageId}
      union all
      select p.id from page p
      inner join descendants d on p.parent_id = d.id
    )
    select id from descendants where id = ${parentId} limit 1
  `)
  return executeHasRow(result)
}

async function breadcrumbsFor(row: Page) {
  const crumbs: Array<{ id: string; title: string }> = []
  let current: Page | null = row
  const seen = new Set<string>()
  while (current) {
    crumbs.push({ id: current.id, title: current.title })
    if (!current.parentId || seen.has(current.parentId)) break
    seen.add(current.id)
    current = await loadPageRow(current.parentId)
  }
  return crumbs.reverse()
}

export async function listPageTree(userId: string, spaceId: string) {
  const access = await assertAccess(userId, { spaceId })
  const db = getDb()
  const rows = await db.select().from(page).where(eq(page.spaceId, spaceId))
  return { space: access.space, tree: asTree(rows), role: access.role }
}

export async function getPageView(
  userId: string,
  pageId: string,
): Promise<PageView> {
  const { space, page: row } = await assertAccess(userId, { pageId })
  if (!row) notFound()
  const db = getDb()
  const authors = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, row.updatedBy))
    .limit(1)
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    title: row.title,
    body: row.body as Json,
    position: row.position,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: authors[0]?.name ?? space.name,
    breadcrumbs: await breadcrumbsFor(row),
    people: await peopleForBody(space, row.body as Json),
  }
}

export async function createPage(
  userId: string,
  input: { spaceId: string; parentId?: string | null; title?: string },
) {
  await assertAccess(userId, { spaceId: input.spaceId })
  if (input.parentId) {
    const parent = await assertAccess(userId, { pageId: input.parentId })
    if (parent.page?.spaceId !== input.spaceId) notFound()
  }
  const db = getDb()
  const id = newId()
  const now = new Date()
  const title = (input.title ?? 'Untitled').trim() || 'Untitled'
  const position = await nextPosition(input.spaceId, input.parentId ?? null)
  await db.insert(page).values({
    id,
    spaceId: input.spaceId,
    parentId: input.parentId ?? null,
    title,
    body: emptyDoc as object,
    bodyText: '',
    position,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
  })
  return getPageView(userId, id)
}

export async function renamePage(
  userId: string,
  input: { pageId: string; title: string },
) {
  await assertAccess(userId, { pageId: input.pageId })
  const title = input.title.trim() || 'Untitled'
  const db = getDb()
  await db
    .update(page)
    .set({ title, updatedBy: userId, updatedAt: new Date() })
    .where(eq(page.id, input.pageId))
  return getPageView(userId, input.pageId)
}

export async function savePage(
  userId: string,
  input: { pageId: string; title: string; body: Json },
) {
  await assertAccess(userId, { pageId: input.pageId })
  const title = input.title.trim() || 'Untitled'
  const db = getDb()
  await db
    .update(page)
    .set({
      title,
      body: input.body,
      bodyText: tiptapToText(input.body),
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .where(eq(page.id, input.pageId))
  return getPageView(userId, input.pageId)
}

export async function movePage(
  userId: string,
  input: { pageId: string; parentId: string | null },
) {
  const { page: row } = await assertAccess(userId, { pageId: input.pageId })
  if (!row) notFound()
  let parentSpaceId = row.spaceId
  if (input.parentId) {
    const parent = await assertAccess(userId, { pageId: input.parentId })
    if (!parent.page || parent.page.spaceId !== row.spaceId) notFound()
    parentSpaceId = parent.page.spaceId
  }

  const db = getDb()
  await db.transaction(async (tx) => {
    await lockSpaces(tx, [row.spaceId, parentSpaceId])
    const currentRows = await tx
      .select()
      .from(page)
      .where(eq(page.id, row.id))
      .limit(1)
    const current = currentRows[0]
    if (!current || current.archivedAt) notFound()
    if (input.parentId) {
      const parentRows = await tx
        .select()
        .from(page)
        .where(eq(page.id, input.parentId))
        .limit(1)
      const parent = parentRows[0]
      if (!parent || parent.archivedAt || parent.spaceId !== current.spaceId)
        notFound()
      if (await targetIsSelfOrDescendant(tx, current.id, input.parentId)) {
        throw new HttpError(
          400,
          'Cannot move a page under itself or a descendant',
        )
      }
    }
    const siblingFilter = input.parentId
      ? and(
          eq(page.spaceId, current.spaceId),
          eq(page.parentId, input.parentId),
        )
      : and(eq(page.spaceId, current.spaceId), isNull(page.parentId))
    const posRows = await tx
      .select({ value: max(page.position) })
      .from(page)
      .where(siblingFilter)
    const position = (posRows[0]?.value ?? 0) + 1000
    await tx
      .update(page)
      .set({
        parentId: input.parentId,
        position,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(page.id, current.id))
  })
  return getPageView(userId, row.id)
}

export async function archivePage(userId: string, pageId: string) {
  await assertAccess(userId, { pageId })
  const db = getDb()
  await db
    .update(page)
    .set({ archivedAt: new Date(), updatedBy: userId, updatedAt: new Date() })
    .where(eq(page.id, pageId))
  return { ok: true as const }
}

export async function getPersonalSpace(userId: string) {
  const db = getDb()
  const rows = await db
    .select()
    .from(space)
    .where(and(eq(space.kind, 'personal'), eq(space.ownerUserId, userId)))
    .limit(1)
  const mine = rows[0]
  if (!mine) notFound()
  await assertAccess(userId, { spaceId: mine.id })
  return mine
}
