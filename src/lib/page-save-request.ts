import { HttpError } from './http'
import { PAGE_BODY_MAX_BYTES, parseSavePayload } from './page-input'
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

export { parseSavePayload } from './page-input'

async function readCappedJson(request: Request): Promise<string | 'too-large'> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isFinite(size) || size < 0 || size > PAGE_BODY_MAX_BYTES) {
      await request.body?.cancel().catch(() => undefined)
      return 'too-large'
    }
  }
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let next = await reader.read()
  while (!next.done) {
    total += next.value.byteLength
    if (total > PAGE_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return 'too-large'
    }
    chunks.push(next.value)
    next = await reader.read()
  }
  return new TextDecoder().decode(chunks.length === 1 ? chunks[0] : concatBytes(chunks, total))
}

function concatBytes(chunks: Uint8Array[], total: number) {
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
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
  const raw = await readCappedJson(request)
  if (raw === 'too-large') return json({ error: 'Payload too large' }, 413)
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return json({ error: 'Bad request' }, 400)
  }
  const parsed = parseSavePayload(payload)
  if (!parsed) return json({ error: 'Bad request' }, 400)
  try {
    const session = await requireUnlockedSession()
    const stamp =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { updatedAt?: unknown }).updatedAt
        : undefined
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) {
      return json({ error: 'Bad request' }, 400)
    }
    const view = await savePage(session.user.id, { ...parsed, updatedAt: stamp })
    await touchLastSpace(session.user.id, view.spaceId)
    return new Response(null, {
      status: 204,
      headers: { 'x-updated-at': view.updatedAt },
    })
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status)
    }
    return json({ error: 'Internal Server Error' }, 500)
  }
}
