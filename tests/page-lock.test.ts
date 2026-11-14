import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { createApiToken } from '../src/lib/api-tokens'
import { getDb, getSql } from '../src/lib/db'
import { handleDrawingRequest } from '../src/lib/drawing-request'
import { handleMcp } from '../src/lib/mcp'
import {
  archivePage,
  createPage,
  getPageView,
  movePage,
  renamePage,
  savePage,
  setPageLock,
} from '../src/lib/pages'
import { page } from '../src/lib/schema'
import { acceptInvite, createInvite, createTeam, removeMember } from '../src/lib/teams'
import { createUser } from './helpers'

const body = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

async function team() {
  const owner = await createUser('Ada Owner')
  const member = await createUser('Bea Member')
  const other = await createUser('Dee Member')
  const outsider = await createUser('Cid Outsider')
  const created = await createTeam(owner.user.id, 'Lock Team')
  const invite = await createInvite(owner.user.id, created.id, member.user.id)
  await acceptInvite(member.user.id, invite.id)
  const otherInvite = await createInvite(owner.user.id, created.id, other.user.id)
  await acceptInvite(other.user.id, otherInvite.id)
  return { owner, member, other, outsider, teamId: created.id, spaceId: created.spaceId }
}

async function rowOf(pageId: string) {
  const rows = await getSql()<
    {
      title: string
      body_text: string
      parent_id: string | null
      archived_at: Date | null
      locked_by: string | null
      locked_at: Date | null
    }[]
  >`select title, body_text, parent_id, archived_at, locked_by, locked_at from page where id = ${pageId}`
  const row = rows[0]
  if (!row) throw new Error('missing page')
  return row
}

describe('page lock', () => {
  it('refuses a member lock and leaves the row unchanged', async () => {
    const { owner, member, other, outsider, spaceId } = await team()
    const note = await createPage(member.user.id, { spaceId, title: 'Member note' })
    const before = await rowOf(note.id)
    await expect(setPageLock(member.user.id, note.id, true)).resolves.toMatchObject({
      lockedByName: 'Bea Member',
    })
    await setPageLock(member.user.id, note.id, false)
    const locked = await setPageLock(owner.user.id, note.id, true)
    expect(locked.lockedByName).toBe('Ada Owner')
    const held = await rowOf(note.id)
    await expect(setPageLock(outsider.user.id, note.id, false)).rejects.toMatchObject({
      status: 404,
    })
    await expect(setPageLock(other.user.id, note.id, false)).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    })
    const after = await rowOf(note.id)
    expect(after.locked_by).toBe(held.locked_by)
    expect(String(after.locked_at)).toBe(String(held.locked_at))
    expect(before.locked_at).toBeNull()
  })

  it('keeps a deleted page and a child of a deleted page at 404', async () => {
    const { owner, spaceId } = await team()
    const parent = await createPage(owner.user.id, { spaceId, title: 'Parent' })
    const child = await createPage(owner.user.id, {
      spaceId,
      parentId: parent.id,
      title: 'Child',
    })
    await archivePage(owner.user.id, parent.id)
    await expect(setPageLock(owner.user.id, parent.id, true)).rejects.toMatchObject({
      status: 404,
    })
    await expect(setPageLock(owner.user.id, child.id, false)).rejects.toMatchObject({
      status: 404,
    })
    await expect(archivePage(owner.user.id, child.id)).rejects.toMatchObject({
      status: 404,
    })
    const childRow = await rowOf(child.id)
    expect(childRow.locked_at).toBeNull()
  })

  it('blocks other members on every write and still allows a child page', async () => {
    const { owner, member, other, spaceId } = await team()
    const note = await createPage(member.user.id, { spaceId, title: 'Writable' })
    const board = await createPage(member.user.id, {
      spaceId,
      title: 'Board',
      kind: 'whiteboard',
    })
    const parent = await createPage(member.user.id, { spaceId, title: 'Parent' })
    await setPageLock(owner.user.id, note.id, true)
    await setPageLock(owner.user.id, board.id, true)
    const before = await rowOf(note.id)
    await expect(
      savePage(member.user.id, { pageId: note.id, title: 'Saved', body: body('secret') }),
    ).rejects.toMatchObject({ status: 423, message: 'Page is locked by Ada Owner' })
    await expect(
      renamePage(member.user.id, { pageId: note.id, title: 'Renamed' }),
    ).rejects.toMatchObject({ status: 423 })
    await expect(
      movePage(member.user.id, { pageId: note.id, parentId: parent.id }),
    ).rejects.toMatchObject({ status: 423 })
    await expect(archivePage(other.user.id, note.id)).rejects.toMatchObject({ status: 403 })
    const token = await createApiToken(member.user.id, {
      name: 'lock',
      scope: 'read_write',
    })
    const current = await getPageView(owner.user.id, note.id)
    const mcp = await handleMcp(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'update_page',
            arguments: {
              page_id: note.id,
              title: 'From token',
              updated_at: current.updatedAt,
            },
          },
        }),
      }),
    )
    const mcpBody = (await mcp.json()) as { error?: { message?: string } }
    expect(mcp.status).toBe(423)
    expect(mcpBody.error?.message).toBe('Page is locked by Ada Owner')
    const drawing = await handleDrawingRequest(
      new Request('http://127.0.0.1/api/drawings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          pageId: board.id,
          version: 1,
          elements: [{ id: 'box', type: 'rectangle', x: 1, y: 2 }],
          appState: {},
          files: {},
        }),
      }),
    )
    expect(drawing.status).toBe(423)
    const after = await rowOf(note.id)
    expect(after.title).toBe(before.title)
    expect(after.body_text).toBe(before.body_text)
    expect(after.parent_id).toBe(before.parent_id)
    expect(after.archived_at).toBeNull()
    const child = await createPage(member.user.id, {
      spaceId,
      parentId: note.id,
      title: 'Still allowed',
    })
    expect(child.parentId).toBe(note.id)
    const scene = await getDb()
      .select({ version: page.id })
      .from(page)
      .where(eq(page.id, board.id))
    expect(scene).toHaveLength(1)
  })

  it('lets the creator and the owner delete a locked page', async () => {
    const { owner, member, other, spaceId } = await team()
    const creatorPage = await createPage(member.user.id, { spaceId, title: 'Creator deletes' })
    const ownerPage = await createPage(member.user.id, { spaceId, title: 'Owner deletes' })
    const memberPage = await createPage(owner.user.id, { spaceId, title: 'Member blocked' })
    await setPageLock(owner.user.id, creatorPage.id, true)
    await setPageLock(member.user.id, ownerPage.id, true)
    await setPageLock(owner.user.id, memberPage.id, true)
    await expect(archivePage(member.user.id, creatorPage.id)).resolves.toEqual({ ok: true })
    await expect(archivePage(owner.user.id, ownerPage.id)).resolves.toEqual({ ok: true })
    await expect(archivePage(other.user.id, memberPage.id)).rejects.toMatchObject({
      status: 403,
    })
    expect((await rowOf(creatorPage.id)).archived_at).not.toBeNull()
    expect((await rowOf(ownerPage.id)).archived_at).not.toBeNull()
    expect((await rowOf(memberPage.id)).archived_at).toBeNull()
  })

  it('lets the locker and the owner edit and unlock', async () => {
    const { owner, member, spaceId } = await team()
    const note = await createPage(member.user.id, { spaceId, title: 'Theirs' })
    await setPageLock(member.user.id, note.id, true)
    const saved = await savePage(member.user.id, {
      pageId: note.id,
      title: 'Locker edit',
      body: body('kept'),
    })
    expect(saved.title).toBe('Locker edit')
    const ownerSaved = await savePage(owner.user.id, {
      pageId: note.id,
      title: 'Owner edit',
      body: body('owner'),
    })
    expect(ownerSaved.title).toBe('Owner edit')
    const unlocked = await setPageLock(owner.user.id, note.id, false)
    expect(unlocked.lockedByName).toBeNull()
    expect(unlocked.canEdit).toBe(true)
    const personal = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Personal',
    })
    const lockedPersonal = await setPageLock(owner.user.id, personal.id, true)
    expect(lockedPersonal.canEdit).toBe(true)
    expect(lockedPersonal.canLock).toBe(true)
  })

  it('lets the owner unlock after the creator leaves', async () => {
    const { owner, member, teamId, spaceId } = await team()
    const note = await createPage(member.user.id, { spaceId, title: 'Left behind' })
    await setPageLock(member.user.id, note.id, true)
    await removeMember(owner.user.id, teamId, member.user.id)
    await expect(setPageLock(member.user.id, note.id, false)).rejects.toMatchObject({
      status: 404,
    })
    const unlocked = await setPageLock(owner.user.id, note.id, false)
    expect(unlocked.lockedByName).toBeNull()
    const row = await rowOf(note.id)
    expect(row.locked_at).toBeNull()
    expect(row.locked_by).toBeNull()
  })

  it('refuses a save that was blocked until the lock committed', async () => {
    const { owner, member, teamId, spaceId } = await team()
    const note = await createPage(member.user.id, { spaceId, title: 'Race' })
    const holder = postgres(process.env.DATABASE_URL, { max: 1 })
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let sawWait = false
    const locking = holder.begin(async (tx) => {
      await tx`select user_id from team_member where team_id = ${teamId} and user_id = ${owner.user.id} for key share`
      await tx`select id from page where id = ${note.id} for update`
      release()
      const start = Date.now()
      while (Date.now() - start < 4000) {
        const waiting = await tx<
          { n: number }[]
        >`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid()`
        if (Number(waiting[0]?.n) > 0) {
          sawWait = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await tx`update page set locked_by = ${owner.user.id}, locked_at = now() where id = ${note.id}`
    })
    await held
    const status = await savePage(member.user.id, {
      pageId: note.id,
      title: 'Late',
      body: body('late'),
    }).then(
      () => 200,
      (error: unknown) =>
        error && typeof error === 'object' && 'status' in error
          ? Number((error as { status: number }).status)
          : 500,
    )
    await locking
    await holder.end({ timeout: 5 })
    const after = await rowOf(note.id)
    expect(sawWait).toBe(true)
    expect(status).toBe(423)
    expect(after.title).toBe('Race')
    expect(after.body_text).not.toContain('late')
    expect(after.locked_by).toBe(owner.user.id)
  })
})
