import { and, eq, inArray } from 'drizzle-orm'
import type { Json } from './body-text'
import { assertAccess } from './access'
import { getDb } from './db'
import { notFound } from './http'
import { type MentionCandidate, type MentionPerson } from './mention-label'
import { teamMember, user, type Space } from './schema'

export { looksLikeEmail, mentionChipText } from './mention-label'
export type { MentionCandidate, MentionPerson } from './mention-label'

export function mentionIdsFromBody(body: Json) {
  const ids = new Set<string>()
  const walk = (node: Json) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    if (
      node.type === 'mention' &&
      node.attrs &&
      typeof node.attrs === 'object' &&
      !Array.isArray(node.attrs)
    ) {
      const id = node.attrs.id
      if (typeof id === 'string' && id) ids.add(id)
    }
    const content = node.content
    if (Array.isArray(content)) {
      for (const child of content) walk(child)
    }
  }
  walk(body)
  return [...ids]
}

export async function peopleForBody(
  spaceRow: Space,
  body: Json,
): Promise<MentionPerson[]> {
  const ids = mentionIdsFromBody(body)
  if (ids.length === 0) return []
  const db = getDb()
  const users = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, ids))
  let memberIds = new Set<string>()
  if (spaceRow.kind === 'team' && spaceRow.teamId) {
    const members = await db
      .select({ userId: teamMember.userId })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, spaceRow.teamId),
          inArray(teamMember.userId, ids),
        ),
      )
    memberIds = new Set(members.map((row) => row.userId))
  } else if (spaceRow.kind === 'personal' && spaceRow.ownerUserId) {
    memberIds = new Set([spaceRow.ownerUserId])
  }
  return users.map((row) => ({
    id: row.id,
    name: row.name,
    member: memberIds.has(row.id),
  }))
}

export async function listMentionCandidates(
  userId: string,
  spaceId: string,
  query: string,
): Promise<MentionCandidate[]> {
  const { space: spaceRow } = await assertAccess(userId, { spaceId })
  const q = query.trim().toLowerCase()
  const db = getDb()
  if (spaceRow.kind === 'personal') {
    const rows = await db
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    const me = rows[0]
    if (!me) return []
    if (q && !me.name.toLowerCase().includes(q)) return []
    return [{ id: me.id, name: me.name }]
  }
  if (!spaceRow.teamId) notFound()
  const rows = await db
    .select({ id: user.id, name: user.name })
    .from(teamMember)
    .innerJoin(user, eq(user.id, teamMember.userId))
    .where(eq(teamMember.teamId, spaceRow.teamId))
  return rows
    .filter((row) => !q || row.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({ id: row.id, name: row.name }))
}
