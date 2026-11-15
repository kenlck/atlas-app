import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiToken } from '../src/lib/api-tokens'
import { getDb } from '../src/lib/db'
import {
  createPage,
  getPageView,
  movePage,
  refreshDocText,
  renamePage,
  savePage,
  setPageLock,
  updatePageForToken,
} from '../src/lib/pages'
import { editedByLine } from '../src/lib/relative-time'
import { searchVisiblePages } from '../src/lib/search'
import { page, user } from '../src/lib/schema'
import {
  acceptInvite,
  createInvite,
  createTeam,
  removeMember,
} from '../src/lib/teams'
import { createUser } from './helpers'

function paragraph(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

async function stamp(id: string) {
  const rows = await getDb().select().from(page).where(eq(page.id, id)).limit(1)
  const row = rows[0]
  if (!row) throw new Error('missing page')
  return row
}

describe('edited by', () => {
  it('drops the name when the editor is missing', () => {
    const now = new Date('2026-01-15T12:02:00Z')
    expect(editedByLine(null, '2026-01-15T12:00:00Z', now)).toBe('Edited 2 min ago')
    expect(editedByLine('  ', '2026-01-15T12:00:00Z', now)).toBe('Edited 2 min ago')
    expect(editedByLine('Bea', '2026-01-15T12:00:00Z', now)).toBe(
      'Edited by Bea · 2 min ago',
    )
  })

  it('stamps text, title, diagram, and token edits only', async () => {
    const ada = await createUser('Ada Edit')
    const bea = await createUser('Bea Edit')
    const made = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      title: 'Note',
    })
    const created = await stamp(made.id)
    expect(created.lastEditedBy).toBe(ada.user.id)
    expect(created.lastEditedAt).toEqual(created.updatedAt)

    await getDb()
      .update(page)
      .set({ lastEditedAt: new Date('2020-01-01T00:00:00Z'), lastEditedBy: bea.user.id })
      .where(eq(page.id, made.id))
    await renamePage(ada.user.id, { pageId: made.id, title: 'Renamed' })
    const titled = await stamp(made.id)
    expect(titled.title).toBe('Renamed')
    expect(titled.lastEditedBy).toBe(ada.user.id)
    expect(titled.lastEditedAt?.toISOString()).not.toBe('2020-01-01T00:00:00.000Z')
    expect(titled.updatedAt.getTime()).not.toBe(created.updatedAt.getTime())

    const beforeText = await stamp(made.id)
    await savePage(ada.user.id, {
      pageId: made.id,
      title: 'Renamed',
      body: paragraph('hello edit'),
      updatedAt: beforeText.updatedAt.toISOString(),
    })
    const texted = await stamp(made.id)
    expect(texted.lastEditedBy).toBe(ada.user.id)
    expect(texted.updatedAt.getTime()).not.toBe(beforeText.updatedAt.getTime())

    await getDb()
      .update(page)
      .set({ lastEditedAt: new Date('2020-01-01T00:00:00Z'), lastEditedBy: bea.user.id })
      .where(eq(page.id, made.id))
    const beforeDiagram = await stamp(made.id)
    await refreshDocText(ada.user.id, made.id, null)
    const diagram = await stamp(made.id)
    expect(diagram.updatedAt).toEqual(beforeDiagram.updatedAt)
    expect(diagram.updatedBy).toBe(beforeDiagram.updatedBy)
    expect(diagram.lastEditedBy).toBe(ada.user.id)
    expect(diagram.lastEditedAt?.toISOString()).not.toBe('2020-01-01T00:00:00.000Z')

    const token = await createApiToken(ada.user.id, {
      name: 'agent',
      scope: 'read_write',
    })
    const current = await getPageView(ada.user.id, made.id)
    await getDb()
      .update(page)
      .set({ lastEditedAt: new Date('2020-01-01T00:00:00Z'), lastEditedBy: bea.user.id })
      .where(eq(page.id, made.id))
    await updatePageForToken(ada.user.id, token.id, {
      pageId: made.id,
      body: paragraph('from the token'),
      updatedAt: current.updatedAt,
    })
    const tokened = await stamp(made.id)
    expect(tokened.lastEditedBy).toBe(ada.user.id)
    expect(tokened.updatedAt.toISOString()).not.toBe(current.updatedAt)
    const stale = await getPageView(ada.user.id, made.id)
    await expect(
      savePage(ada.user.id, {
        pageId: made.id,
        title: stale.title,
        body: paragraph('stale editor'),
        updatedAt: current.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 })

    const parent = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      title: 'Parent',
    })
    const beforeMove = await stamp(made.id)
    await movePage(ada.user.id, { pageId: made.id, parentId: parent.id })
    await setPageLock(ada.user.id, made.id, true)
    await setPageLock(ada.user.id, made.id, false)
    const parked = await stamp(made.id)
    expect(parked.parentId).toBe(parent.id)
    expect(parked.lockedAt).toBeNull()
    expect(parked.lastEditedAt).toEqual(beforeMove.lastEditedAt)
    expect(parked.lastEditedBy).toBe(beforeMove.lastEditedBy)
    expect(parked.updatedAt).toEqual(beforeMove.updatedAt)

    const team = await createTeam(ada.user.id, 'Edit Team')
    const invite = await createInvite(ada.user.id, team.id, bea.user.id)
    await acceptInvite(bea.user.id, invite.id)
    const shared = await createPage(ada.user.id, {
      spaceId: team.spaceId,
      title: 'Shared edit',
    })
    const beforeRemove = await stamp(shared.id)
    await removeMember(ada.user.id, team.id, bea.user.id)
    const afterRemove = await stamp(shared.id)
    expect(afterRemove.lastEditedAt).toEqual(beforeRemove.lastEditedAt)
    expect(afterRemove.lastEditedBy).toBe(beforeRemove.lastEditedBy)

    const older = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      title: 'Recency alpha',
    })
    const newer = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      title: 'Recency beta',
    })
    await getDb()
      .update(page)
      .set({
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        lastEditedAt: new Date('2020-01-01T00:00:00Z'),
      })
      .where(eq(page.id, older.id))
    await getDb()
      .update(page)
      .set({
        updatedAt: new Date('2020-01-01T00:00:00Z'),
        lastEditedAt: new Date('2024-01-01T00:00:00Z'),
      })
      .where(eq(page.id, newer.id))
    const hits = await searchVisiblePages(ada.user.id, 'Recency')
    expect(hits.map((hit) => hit.id)).toEqual([newer.id, older.id])

    await getDb()
      .update(page)
      .set({ lastEditedBy: bea.user.id })
      .where(eq(page.id, made.id))
    await getDb().delete(user).where(eq(user.id, bea.user.id))
    const gone = await stamp(made.id)
    expect(gone.lastEditedBy).toBeNull()
    const cleared = await getPageView(ada.user.id, made.id)
    expect(cleared.lastEditedByName).toBeNull()
    expect(
      editedByLine(cleared.lastEditedByName, cleared.lastEditedAt ?? cleared.updatedAt),
    ).not.toMatch(/\bby\b/)
  })
})
