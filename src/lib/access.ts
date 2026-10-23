import { eq } from 'drizzle-orm'
import { getDb } from './db'
import { notFound } from './http'
import { page, space, type Page, type Space } from './schema'

export type AccessTarget = { spaceId: string } | { pageId: string }

export type AccessResult = {
  space: Space
  page: Page | null
}

async function loadSpace(spaceId: string) {
  const db = getDb()
  const rows = await db.select().from(space).where(eq(space.id, spaceId)).limit(1)
  return rows[0] ?? null
}

async function loadPage(pageId: string) {
  const db = getDb()
  const rows = await db.select().from(page).where(eq(page.id, pageId)).limit(1)
  return rows[0] ?? null
}

async function hasArchivedAncestor(row: Page) {
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
    current = await loadPage(current.parentId)
    if (!current) {
      return true
    }
  }
  return false
}

export async function assertAccess(
  userId: string,
  target: AccessTarget,
): Promise<AccessResult> {
  let spaceRow: Space | null = null
  let pageRow: Page | null = null

  if ('pageId' in target) {
    pageRow = await loadPage(target.pageId)
    if (!pageRow) {
      notFound()
    }
    spaceRow = await loadSpace(pageRow.spaceId)
  } else {
    spaceRow = await loadSpace(target.spaceId)
  }

  if (!spaceRow) {
    notFound()
  }

  const allowed =
    spaceRow.kind === 'personal' && spaceRow.ownerUserId === userId
  if (!allowed) {
    notFound()
  }

  if (pageRow && (await hasArchivedAncestor(pageRow))) {
    notFound()
  }

  return { space: spaceRow, page: pageRow }
}
