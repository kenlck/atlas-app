import type { Json } from './body-text'
import { HttpError } from './http'

export const PAGE_BODY_MAX_BYTES = 1024 * 1024
export const PAGE_TITLE_MAX = 200

export function pageBodyBytes(body: unknown) {
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isMark(value: unknown) {
  if (!isPlainObject(value)) return false
  if (typeof value.type !== 'string' || value.type.length === 0) return false
  return !('attrs' in value) || value.attrs === undefined || isPlainObject(value.attrs)
}

function isDoc(value: unknown): value is Json {
  if (!isPlainObject(value)) return false
  if (typeof value.type !== 'string' || value.type.length === 0) return false
  if ('text' in value && value.text !== undefined && typeof value.text !== 'string') {
    return false
  }
  if (value.type === 'text' && typeof value.text !== 'string') return false
  if ('attrs' in value && value.attrs !== undefined && !isPlainObject(value.attrs)) return false
  if ('marks' in value && value.marks !== undefined) {
    if (!Array.isArray(value.marks) || !value.marks.every(isMark)) return false
  }
  if (!('content' in value) || value.content === undefined) return true
  if (!Array.isArray(value.content)) return false
  return value.content.every(isDoc)
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
