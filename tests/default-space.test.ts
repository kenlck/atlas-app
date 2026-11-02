import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '../src/lib/db'
import { createPage, savePage } from '../src/lib/pages'
import { user } from '../src/lib/schema'
import { getDefaultSpace, touchLastSpace } from '../src/lib/spaces'
import {
  acceptInvite,
  createInvite,
  createTeam,
  deleteTeam,
  removeMember,
} from '../src/lib/teams'
import { createUser } from './helpers'

async function lastSpaceId(userId: string) {
  const rows = await getDb()
    .select({ lastSpaceId: user.lastSpaceId })
    .from(user)
    .where(eq(user.id, userId))
  return rows[0]?.lastSpaceId ?? null
}

async function teamWithMember() {
  const owner = await createUser('Owner')
  const member = await createUser('Member')
  const created = await createTeam(owner.user.id, 'Writers')
  await acceptInvite(
    member.user.id,
    (await createInvite(owner.user.id, created.id, member.user.id)).id,
  )
  return { owner, member, created }
}

describe('default space', () => {
  it('starts in the personal space', async () => {
    const me = await createUser('Fresh')
    expect(await lastSpaceId(me.user.id)).toBeNull()
    expect((await getDefaultSpace(me.user.id)).id).toBe(me.space.id)
  })

  it('returns the last space the user worked in', async () => {
    const { member, created } = await teamWithMember()
    await touchLastSpace(member.user.id, created.spaceId)
    expect((await getDefaultSpace(member.user.id)).id).toBe(created.spaceId)
    await touchLastSpace(member.user.id, member.space.id)
    expect((await getDefaultSpace(member.user.id)).id).toBe(member.space.id)
  })

  it('follows the space of a saved page', async () => {
    const { member, created } = await teamWithMember()
    const page = await createPage(member.user.id, {
      spaceId: created.spaceId,
      title: 'Shared',
    })
    const view = await savePage(member.user.id, {
      pageId: page.id,
      title: 'Shared',
      body: { type: 'doc', content: [] },
    })
    await touchLastSpace(member.user.id, view.spaceId)
    expect((await getDefaultSpace(member.user.id)).id).toBe(created.spaceId)
  })

  it('falls back to the personal space after removal from the team', async () => {
    const { owner, member, created } = await teamWithMember()
    await touchLastSpace(member.user.id, created.spaceId)
    await removeMember(owner.user.id, created.id, member.user.id)
    expect(await lastSpaceId(member.user.id)).toBe(created.spaceId)
    expect((await getDefaultSpace(member.user.id)).id).toBe(member.space.id)
  })

  it('clears the stored space when the team is deleted', async () => {
    const { owner, member, created } = await teamWithMember()
    await touchLastSpace(member.user.id, created.spaceId)
    await deleteTeam(owner.user.id, created.id)
    expect(await lastSpaceId(member.user.id)).toBeNull()
    expect((await getDefaultSpace(member.user.id)).id).toBe(member.space.id)
  })
})
