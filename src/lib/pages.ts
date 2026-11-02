import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { assertAccess } from './access'
import { emptyDoc, tiptapToText, type Json } from './body-text'
import { diagramIds } from './diagram'
import { getDb } from './db'
import {
  cleanPreviewSvg,
  drawingLabelText,
  emptyScene,
  sceneFromStored,
  type DrawingScene,
} from './drawing'
import { HttpError, notFound } from './http'
import { newId } from './ids'
import { mentionChipText, peopleForBody } from './mentions'
import type { MentionPerson } from './mentions'
import { drawing, page, space, user, type Page, type Space } from './schema'

export type PageKind = 'doc' | 'whiteboard'

export type TreeNode = {
  id: string
  title: string
  kind: PageKind
  parentId: string | null
  position: number
  children: TreeNode[]
}

export type PageView = {
  id: string
  spaceId: string
  parentId: string | null
  kind: PageKind
  title: string
  body: Json
  position: number
  updatedAt: string
  updatedByName: string
  breadcrumbs: Array<{ id: string; title: string }>
  people: MentionPerson[]
  drawing: {
    id: string
    version: number
    elements: DrawingScene['elements']
    appState: DrawingScene['appState']
  } | null
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
        kind: row.kind,
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

const MAX_PAGE_DEPTH = 1000

export async function targetIsSelfOrDescendant(
  tx: MoveTx,
  pageId: string,
  parentId: string,
) {
  const result = await tx.execute(sql`
    with recursive descendants as (
      select id, 0 as depth, array[id] as path
      from page
      where id = ${pageId}
      union all
      select p.id, d.depth + 1, d.path || p.id
      from page p
      inner join descendants d on p.parent_id = d.id
      where d.depth < ${MAX_PAGE_DEPTH}
        and not (p.id = any(d.path))
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
  const board =
    row.kind === 'whiteboard'
      ? (
          await db
            .select()
            .from(drawing)
            .where(eq(drawing.pageId, row.id))
            .limit(1)
        )[0]
      : null
  if (row.kind === 'whiteboard' && !board) notFound()
  const scene = board ? sceneFromStored(board.scene) : null
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    kind: row.kind,
    title: row.title,
    body: row.body as Json,
    position: row.position,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: authors[0]?.name ?? space.name,
    breadcrumbs: await breadcrumbsFor(row),
    people:
      row.kind === 'whiteboard'
        ? []
        : await peopleForBody(space, row.body as Json),
    drawing: board
      ? {
          id: board.id,
          version: board.version,
          elements: scene?.elements ?? [],
          appState: scene?.appState ?? {},
        }
      : null,
  }
}

export async function createPage(
  userId: string,
  input: {
    spaceId: string
    parentId?: string | null
    title?: string
    kind?: PageKind
  },
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
  const kind: PageKind = input.kind === 'whiteboard' ? 'whiteboard' : 'doc'
  const position = await nextPosition(input.spaceId, input.parentId ?? null)
  await db.transaction(async (tx) => {
    await tx.insert(page).values({
      id,
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      kind,
      title,
      body: emptyDoc as object,
      bodyText: '',
      position,
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    if (kind === 'whiteboard') {
      await tx.insert(drawing).values({
        id: newId(),
        pageId: id,
        scene: emptyScene,
        version: 1,
      })
    }
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

type DrawingDb = Pick<ReturnType<typeof getDb>, 'select' | 'insert'>

async function labelsForBody(db: DrawingDb, body: Json) {
  const ids = diagramIds(body)
  const unique = [...new Set(ids)]
  if (!unique.length) return ''
  const rows = await db
    .select({ id: drawing.id, scene: drawing.scene })
    .from(drawing)
    .where(inArray(drawing.id, unique))
  const byId = new Map(
    rows.map((row) => [
      row.id,
      drawingLabelText(sceneFromStored(row.scene).elements),
    ]),
  )
  return ids
    .map((id) => byId.get(id) ?? '')
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n')
}

async function indexedBodyText(spaceRow: Space, body: Json) {
  const people = await peopleForBody(spaceRow, body)
  const labels = new Map(
    people.map((person) => [person.id, mentionChipText(person)]),
  )
  const text = tiptapToText(body, (id) => labels.get(id) ?? 'Unknown person')
  const drawings = await labelsForBody(getDb(), body)
  return [text, drawings].filter(Boolean).join('\n')
}

// A block keeps a drawing id only when that row already belongs to this page
// and no earlier block in the body uses it. Anything else is copied, but only
// when the saver can open the source page. An unknown id and a denied id both
// run the same access lookup and both drop the id, so a later read cannot
// tell those two cases apart. Scene and preview load only after access passes.
const MISSING_DRAWING_PAGE = 'missing-drawing-page'

function blankDiagram(record: { [key: string]: Json }, attrs: { [key: string]: Json }) {
  attrs.drawingId = ''
  record.attrs = attrs
  return record
}

async function adoptDiagrams(db: DrawingDb, userId: string, pageId: string, body: Json) {
  const seen = new Set<string>()
  const walk = async (value: Json): Promise<Json> => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) {
      const next: Json[] = []
      for (const item of value) next.push(await walk(item))
      return next
    }
    const record = { ...(value as { [key: string]: Json }) }
    if (record.type === 'diagram') {
      const attrs =
        record.attrs && typeof record.attrs === 'object' && !Array.isArray(record.attrs)
          ? { ...(record.attrs as { [key: string]: Json }) }
          : {}
      const current = typeof attrs.drawingId === 'string' ? attrs.drawingId : ''
      if (!current) return value
      const rows = await db
        .select({ id: drawing.id, pageId: drawing.pageId })
        .from(drawing)
        .where(eq(drawing.id, current))
        .limit(1)
      const row = rows[0]
      if (row && row.pageId === pageId && !seen.has(current)) {
        seen.add(current)
        return value
      }
      let accessible = false
      try {
        await assertAccess(userId, { pageId: row ? row.pageId : MISSING_DRAWING_PAGE })
        accessible = true
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error
      }
      if (!row || !accessible) return blankDiagram(record, attrs)
      const full = await db
        .select({ scene: drawing.scene, previewSvg: drawing.previewSvg })
        .from(drawing)
        .where(eq(drawing.id, row.id))
        .limit(1)
      const source = full[0]
      if (!source) return blankDiagram(record, attrs)
      const id = newId()
      await db.insert(drawing).values({
        id,
        pageId,
        scene: source.scene,
        version: 1,
        previewSvg: cleanPreviewSvg(source.previewSvg),
        updatedAt: new Date(),
      })
      seen.add(id)
      attrs.drawingId = id
      record.attrs = attrs
      return record
    }
    if (Array.isArray(record.content)) {
      const content: Json[] = []
      for (const child of record.content) content.push(await walk(child))
      record.content = content
    }
    return record
  }
  return walk(body)
}

async function writeDocBody(
  userId: string,
  pageId: string,
  title: string,
  body: Json,
  tokenId: string | null,
  expectedUpdatedAt: Date | null,
) {
  const db = getDb()
  await db.transaction(async (tx) => {
    const adopted = await adoptDiagrams(tx, userId, pageId, body)
    const rows = await tx
      .update(page)
      .set({
        title,
        body: adopted,
        updatedBy: userId,
        updatedAt: new Date(),
        ...(tokenId ? { updatedViaTokenId: tokenId } : {}),
      })
      .where(
        expectedUpdatedAt
          ? and(eq(page.id, pageId), eq(page.updatedAt, expectedUpdatedAt))
          : eq(page.id, pageId),
      )
      .returning({ id: page.id })
    if (rows.length === 0) throw new HttpError(409, 'Conflict')
  })
  const access = await assertAccess(userId, { pageId })
  const stored = access.page?.body as Json
  await db
    .update(page)
    .set({ bodyText: await indexedBodyText(access.space, stored) })
    .where(eq(page.id, pageId))
}

export async function savePage(
  userId: string,
  input: { pageId: string; title: string; body: Json },
) {
  const access = await assertAccess(userId, { pageId: input.pageId })
  const title = input.title.trim() || 'Untitled'
  const db = getDb()
  if (access.page?.kind === 'whiteboard') {
    await db
      .update(page)
      .set({ title, updatedBy: userId, updatedAt: new Date() })
      .where(eq(page.id, input.pageId))
    return getPageView(userId, input.pageId)
  }
  await writeDocBody(userId, input.pageId, title, input.body, null, null)
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

export async function createPageForToken(
  userId: string,
  tokenId: string,
  input: {
    spaceId: string
    parentId?: string | null
    title?: string
    body: Json
  },
) {
  const created = await createPage(userId, {
    spaceId: input.spaceId,
    parentId: input.parentId,
    title: input.title,
  })
  await writeDocBody(userId, created.id, created.title, input.body, tokenId, null)
  return getPageView(userId, created.id)
}

export async function updatePageForToken(
  userId: string,
  tokenId: string,
  input: { pageId: string; title?: string; body?: Json; updatedAt: unknown },
) {
  const access = await assertAccess(userId, { pageId: input.pageId })
  const row = access.page
  if (!row) notFound()
  const expected =
    typeof input.updatedAt === 'string' ? Date.parse(input.updatedAt) : Number.NaN
  if (!Number.isFinite(expected) || row.updatedAt.getTime() !== expected) {
    throw new HttpError(409, 'Conflict')
  }
  const db = getDb()
  if (row.kind === 'whiteboard') {
    if (input.title === undefined) return getPageView(userId, row.id)
    const title = input.title.trim() || 'Untitled'
    const written = await db
      .update(page)
      .set({
        title,
        updatedBy: userId,
        updatedAt: new Date(),
        updatedViaTokenId: tokenId,
      })
      .where(and(eq(page.id, row.id), eq(page.updatedAt, row.updatedAt)))
      .returning({ id: page.id })
    if (written.length === 0) throw new HttpError(409, 'Conflict')
    return getPageView(userId, row.id)
  }
  const title =
    input.title === undefined ? row.title : input.title.trim() || 'Untitled'
  const body = input.body === undefined ? (row.body as Json) : input.body
  await writeDocBody(userId, row.id, title, body, tokenId, row.updatedAt)
  return getPageView(userId, row.id)
}

export async function refreshDocText(
  userId: string,
  pageId: string,
  tokenId: string | null,
) {
  const access = await assertAccess(userId, { pageId })
  if (!access.page || access.page.kind !== 'doc') return
  await getDb()
    .update(page)
    .set({
      bodyText: await indexedBodyText(access.space, access.page.body as Json),
      updatedBy: userId,
      updatedAt: new Date(),
      ...(tokenId ? { updatedViaTokenId: tokenId } : {}),
    })
    .where(eq(page.id, pageId))
}

export async function createDiagram(userId: string, pageId: string) {
  const access = await assertAccess(userId, { pageId })
  if (!access.page || access.page.kind !== 'doc') notFound()
  const id = newId()
  await getDb().insert(drawing).values({
    id,
    pageId,
    scene: emptyScene,
    version: 1,
    previewSvg: null,
    updatedAt: new Date(),
  })
  return { id, version: 1 }
}

export async function cloneDiagram(
  userId: string,
  input: { pageId: string; drawingId: string },
) {
  const access = await assertAccess(userId, { pageId: input.pageId })
  if (!access.page || access.page.kind !== 'doc') notFound()
  const db = getDb()
  const rows = await db
    .select()
    .from(drawing)
    .where(eq(drawing.id, input.drawingId))
    .limit(1)
  const source = rows[0]
  if (!source) notFound()
  await assertAccess(userId, { pageId: source.pageId })
  const id = newId()
  await db.insert(drawing).values({
    id,
    pageId: input.pageId,
    scene: source.scene,
    version: 1,
    previewSvg: cleanPreviewSvg(source.previewSvg),
    updatedAt: new Date(),
  })
  return { id, version: 1 }
}

export async function duplicatePage(userId: string, pageId: string) {
  const access = await assertAccess(userId, { pageId })
  const row = access.page
  if (!row || row.kind !== 'doc') notFound()
  const created = await createPage(userId, {
    spaceId: row.spaceId,
    parentId: row.parentId,
    title: row.title,
  })
  await writeDocBody(userId, created.id, row.title, row.body as Json, null, null)
  return getPageView(userId, created.id)
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
