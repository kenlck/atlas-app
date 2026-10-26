import type { Json } from './body-text'
import { HttpError } from './http'
import { savePage } from './pages'
import { requireUnlockedSession } from './session'
import { touchLastSpace } from './spaces'

function appOrigin() {
  const raw = process.env.BETTER_AUTH_URL
  if (!raw || raw.trim() === '') return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

// Sync XHR, sendBeacon, and keepalive fetch on this origin all send Origin.
export function saveOriginAllowed(request: Request) {
  const expected = appOrigin()
  const header = request.headers.get('origin')
  if (!expected || !header) return false
  try {
    return new URL(header).origin === expected
  } catch {
    return false
  }
}

function isDoc(value: unknown): value is Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || record.type.length === 0) return false
  if (!('content' in record) || record.content === undefined) return true
  if (!Array.isArray(record.content)) return false
  return record.content.every(isDoc)
}

export function parseSavePayload(
  value: unknown,
): { pageId: string; title: string; body: Json } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.pageId !== 'string' || record.pageId.length === 0) return null
  if (typeof record.title !== 'string') return null
  if (!isDoc(record.body)) return null
  return {
    pageId: record.pageId,
    title: record.title,
    body: record.body,
  }
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function handlePageSave(request: Request) {
  if (!saveOriginAllowed(request)) {
    return json({ error: 'Forbidden' }, 403)
  }
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return json({ error: 'Bad request' }, 400)
  }
  const parsed = parseSavePayload(payload)
  if (!parsed) return json({ error: 'Bad request' }, 400)
  try {
    const session = await requireUnlockedSession()
    const view = await savePage(session.user.id, parsed)
    await touchLastSpace(session.user.id, view.spaceId)
    return new Response(null, { status: 204 })
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status)
    }
    return json({ error: 'Internal Server Error' }, 500)
  }
}
