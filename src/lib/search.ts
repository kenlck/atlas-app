import { getSql } from './db'

const MIN_QUERY = 2
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 21
const SNIPPET_RADIUS = 40

export type SearchHit = {
  id: string
  title: string
  spaceId: string
  spaceName: string
  updatedAt: string
  group: 'title' | 'content'
  snippet: string
}

export type SearchOptions = {
  limit?: number
}

type SearchRow = {
  id: string
  title: string
  body_text: string
  space_id: string
  space_name: string
  updated_at: Date | string
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function resolveLimit(opts?: SearchOptions) {
  const value = opts?.limit
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return DEFAULT_LIMIT
  }
  return Math.min(value, MAX_LIMIT)
}

function includesFold(haystack: string, needle: string) {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function snippetAround(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return ''
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS)
  const slice = text.slice(start, end).replace(/\s+/g, ' ')
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${slice}${suffix}`
}

function isoTime(value: Date | string) {
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

// Visibility and the ILIKE match live in this one query.
export async function searchVisiblePages(
  userId: string,
  query: string,
  opts?: SearchOptions,
): Promise<SearchHit[]> {
  const trimmed = query.trim()
  if (trimmed.length < MIN_QUERY) return []
  const pattern = `%${escapeLike(trimmed)}%`
  const limit = resolveLimit(opts)
  const rows = await getSql()<SearchRow[]>`
    WITH RECURSIVE hidden AS (
      SELECT id FROM page WHERE archived_at IS NOT NULL
      UNION
      SELECT child.id
      FROM page AS child
      INNER JOIN hidden ON child.parent_id = hidden.id
    )
    SELECT
      page.id,
      page.title,
      page.body_text,
      page.space_id,
      space.name AS space_name,
      page.updated_at
    FROM page
    INNER JOIN space ON space.id = page.space_id
    WHERE page.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM hidden WHERE hidden.id = page.id
      )
      AND (
        (space.kind = 'personal' AND space.owner_user_id = ${userId})
        OR (
          space.kind = 'team'
          AND EXISTS (
            SELECT 1 FROM team_member
            WHERE team_member.team_id = space.team_id
              AND team_member.user_id = ${userId}
          )
        )
      )
      AND (
        page.title ILIKE ${pattern} ESCAPE '\\'
        OR page.body_text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY
      CASE WHEN page.title ILIKE ${pattern} ESCAPE '\\' THEN 0 ELSE 1 END,
      page.updated_at DESC
    LIMIT ${limit}
  `
  return rows.map((row) => {
    const titleMatch = includesFold(row.title, trimmed)
    return {
      id: row.id,
      title: row.title,
      spaceId: row.space_id,
      spaceName: row.space_name,
      updatedAt: isoTime(row.updated_at),
      group: titleMatch ? 'title' : 'content',
      snippet: titleMatch ? '' : snippetAround(row.body_text ?? '', trimmed),
    }
  })
}
