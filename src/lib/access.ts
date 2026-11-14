import { and, eq } from 'drizzle-orm'
import { getDb } from './db'
import { notFound } from './http'
import { page, space, teamMember } from './schema'
import type { Page, Space } from './schema'

export type SpaceRole = 'personal' | 'owner' | 'member'

export type AccessTarget = { spaceId: string } | { pageId: string }

export type AccessResult = {
  space: Space
  page: Page | null
  role: SpaceRole
}

type AccessDb = Pick<ReturnType<typeof getDb>, 'select'>

async function loadSpace(db: AccessDb, spaceId: string) {
  const rows = await db
    .select()
    .from(space)
    .where(eq(space.id, spaceId))
    .limit(1)
  return rows[0] ?? null
}

async function loadPage(db: AccessDb, pageId: string) {
  const rows = await db.select().from(page).where(eq(page.id, pageId)).limit(1)
  return rows[0] ?? null
}

async function hasArchivedAncestor(db: AccessDb, row: Page) {
  let current: Page | null = row
  const seen = new Set<string>()
  while (current) {
    if (current.archivedAt) {
      return true
    }
    if (!current.parentId) {
      return false
    }
    if (seen.has(current.parentId)) {
      return true
    }
    seen.add(current.id)
    current = await loadPage(db, current.parentId)
  }
  return true
}

export async function assertAccess(
  userId: string,
  target: AccessTarget,
  db: AccessDb = getDb(),
): Promise<AccessResult> {
  let spaceRow: Space | null = null
  let pageRow: Page | null = null

  if ('pageId' in target) {
    pageRow = await loadPage(db, target.pageId)
    if (!pageRow) {
      notFound()
    }
    spaceRow = await loadSpace(db, pageRow.spaceId)
  } else {
    spaceRow = await loadSpace(db, target.spaceId)
  }

  if (!spaceRow) {
    notFound()
  }

  let role: SpaceRole | null = null
  if (spaceRow.kind === 'personal' && spaceRow.ownerUserId === userId) {
    role = 'personal'
  } else if (spaceRow.kind === 'team' && spaceRow.teamId) {
    const members = await db
      .select({ role: teamMember.role })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, spaceRow.teamId),
          eq(teamMember.userId, userId),
        ),
      )
      .limit(1)
    if (members[0]) role = members[0].role
  }
  if (!role) notFound()

  if (pageRow && (await hasArchivedAncestor(db, pageRow))) {
    notFound()
  }

  return { space: spaceRow, page: pageRow, role }
}
