import type { Json } from './body-text'
import { HttpError } from './http'

export const PAGE_BODY_MAX_BYTES = 1024 * 1024
export const PAGE_TITLE_MAX = 200

export function pageBodyBytes(body: unknown) {
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
}

function isDoc(value: unknown): value is Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || record.type.length === 0) return false
  if ('text' in record && record.text !== undefined && typeof record.text !== 'string') {
    return false
  }
  if (record.type === 'text' && typeof record.text !== 'string') return false
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

export function assertPageTitle(title: unknown) {
  if (typeof title !== 'string') throw new HttpError(400, 'Bad request')
  const trimmed = title.trim()
  if (trimmed.length > PAGE_TITLE_MAX) throw new HttpError(400, 'Title is too long')
  return trimmed || 'Untitled'
}

export function assertPageBody(body: unknown) {
  if (!isDoc(body)) throw new HttpError(400, 'Bad request')
  if (pageBodyBytes(body) > PAGE_BODY_MAX_BYTES) {
    throw new HttpError(413, 'Payload too large')
  }
}
