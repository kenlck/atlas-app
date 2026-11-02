import { and, eq, sql } from 'drizzle-orm'
import { authenticateBearer, type TokenScope } from './api-tokens'
import { assertAccess } from './access'
import { getDb } from './db'
import {
  BOARD_CONFLICT,
  DRAWING_MAX_BYTES,
  cleanPreviewSvg,
  drawingLabelText,
  plainAppState,
  plainElements,
  sceneFromStored,
  sceneRejection,
  type DrawingScene,
} from './drawing'
import { HttpError, notFound } from './http'
import { saveOriginAllowed } from './page-save-request'
import { refreshDocText } from './pages'
import { page, drawing } from './schema'
import { requireUnlockedSession } from './session'
import { touchLastSpace } from './spaces'

type Caller = {
  userId: string
  scope: 'session' | TokenScope
  tokenId: string | null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

async function readCapped(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isFinite(size) || size < 0 || size > DRAWING_MAX_BYTES) {
      await request.body?.cancel().catch(() => undefined)
      return null
    }
  }
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let next = await reader.read()
  while (!next.done) {
    total += next.value.byteLength
    if (total > DRAWING_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(next.value)
    next = await reader.read()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function callerOf(request: Request): Promise<Caller> {
  const header = request.headers.get('authorization')
  if (header && header.trim() !== '') {
    const auth = await authenticateBearer(header)
    return { userId: auth.userId, scope: auth.scope, tokenId: auth.tokenId }
  }
  // A same-origin GET often omits Origin. State-changing calls still must send it.
  if (request.method.toUpperCase() === 'POST' && !saveOriginAllowed(request)) {
    throw new HttpError(403, 'Forbidden')
  }
  const session = await requireUnlockedSession()
  return { userId: session.user.id, scope: 'session', tokenId: null }
}

function oneId(pageId: unknown, drawingId: unknown) {
  const pageOk = typeof pageId === 'string' && pageId.length > 0
  const drawingOk = typeof drawingId === 'string' && drawingId.length > 0
  if (pageOk === drawingOk) return null
  return pageOk
    ? { pageId: pageId as string, drawingId: null }
    : { pageId: null, drawingId: drawingId as string }
}

async function loadTarget(ids: { pageId: string | null; drawingId: string | null }) {
  const db = getDb()
  if (ids.drawingId) {
    const rows = await db
      .select({ drawing, page })
      .from(drawing)
      .innerJoin(page, eq(page.id, drawing.pageId))
      .where(eq(drawing.id, ids.drawingId))
      .limit(1)
    return rows[0] ?? null
  }
  const rows = await db
    .select({ drawing, page })
    .from(drawing)
    .innerJoin(page, eq(page.id, drawing.pageId))
    .where(eq(drawing.pageId, ids.pageId ?? ''))
    .limit(1)
  return rows[0] ?? null
}

async function openDrawing(userId: string, ids: { pageId: string | null; drawingId: string | null }) {
  const target = await loadTarget(ids)
  if (!target) notFound()
  const access = await assertAccess(userId, { pageId: target.page.id })
  if (!access.page) notFound()
  return { ...target, spaceId: access.space.id }
}

function boardPayload(row: {
  id: string
  pageId: string
  version: number
  scene: unknown
  previewSvg?: string | null
}) {
  const scene = sceneFromStored(row.scene)
  return {
    id: row.id,
    pageId: row.pageId,
    version: row.version,
    elements: scene.elements,
    appState: scene.appState,
    previewSvg: cleanPreviewSvg(row.previewSvg),
  }
}

export async function handleDrawingRequest(request: Request) {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  }

  let raw: Uint8Array | null = null
  if (method === 'POST') {
    raw = await readCapped(request)
    if (!raw) return json({ error: 'Payload too large' }, 413)
  }

  try {
    const caller = await callerOf(request)
    if (method === 'GET') {
      const url = new URL(request.url)
      const ids = oneId(url.searchParams.get('pageId'), url.searchParams.get('drawingId'))
      if (!ids) return json({ error: 'Bad request' }, 400)
      const board = await openDrawing(caller.userId, ids)
      return json(boardPayload(board.drawing))
    }

    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()))
    } catch {
      return json({ error: 'Bad request' }, 400)
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ error: 'Bad request' }, 400)
    }
    const record = payload as Record<string, unknown>
    const ids = oneId(record.pageId, record.drawingId)
    if (!ids) return json({ error: 'Bad request' }, 400)
    const board = await openDrawing(caller.userId, ids)
    if (caller.scope === 'read') throw new HttpError(403, 'Forbidden')

    const elements = plainElements(record.elements)
    if (!elements) return json({ error: 'Bad request' }, 400)
    if (record.appState != null && (typeof record.appState !== 'object' || Array.isArray(record.appState))) {
      return json({ error: 'Bad request' }, 400)
    }
    if (sceneRejection({ files: record.files ?? null, elements })) {
      return json({ error: 'Bad request' }, 400)
    }
    const version = record.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      return json({ error: 'Bad request' }, 400)
    }
    const scene: DrawingScene = {
      elements,
      appState: plainAppState(record.appState),
    }
    const preview =
      record.previewSvg === undefined ? undefined : cleanPreviewSvg(record.previewSvg)
    const title =
      record.title === undefined
        ? null
        : typeof record.title === 'string'
          ? record.title.trim() || 'Untitled'
          : undefined
    if (title === undefined) return json({ error: 'Bad request' }, 400)

    const db = getDb()
    const written = await db.transaction(async (tx) => {
      const rows = await tx
        .update(drawing)
        .set({
          scene,
          version: sql`${drawing.version} + 1`,
          updatedAt: new Date(),
          ...(preview === undefined ? {} : { previewSvg: preview }),
        })
        .where(and(eq(drawing.id, board.drawing.id), eq(drawing.version, version)))
        .returning({ id: drawing.id, version: drawing.version, pageId: drawing.pageId })
      if (rows.length === 0) return null
      if (board.page.kind === 'whiteboard') {
        await tx
          .update(page)
          .set({
            ...(title === null ? {} : { title }),
            bodyText: drawingLabelText(elements),
            updatedBy: caller.userId,
            updatedAt: new Date(),
            ...(caller.tokenId ? { updatedViaTokenId: caller.tokenId } : {}),
          })
          .where(eq(page.id, board.page.id))
      }
      return rows[0]
    })
    if (!written) return json({ error: BOARD_CONFLICT }, 409)
    if (board.page.kind !== 'whiteboard') {
      await refreshDocText(caller.userId, board.page.id, caller.tokenId)
    }
    await touchLastSpace(caller.userId, board.spaceId)
    return json({ id: written.id, pageId: written.pageId, version: written.version })
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    return json({ error: 'Internal Server Error' }, 500)
  }
}
