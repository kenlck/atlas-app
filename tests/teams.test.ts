import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { assertAccess } from '../src/lib/access'
import { getDb, getSql } from '../src/lib/db'
import { HttpError } from '../src/lib/http'
import {
  createMentionCache,
  mentionChipText,
  mentionPerson,
  listMentionCandidates,
  peopleForBody,
} from '../src/lib/mentions'
import {
  archivePage,
  createPage,
  getPageView,
  listPageTree,
  movePage,
  renamePage,
  savePage,
} from '../src/lib/pages'
import { space, teamInvite, teamMember, user } from '../src/lib/schema'
import {
  NO_ACCOUNT,
  acceptInvite,
  createInvite,
  createTeam,
  declineInvite,
  deleteTeam,
  getTeamSettings,
  listInvitations,
  lookupAccount,
  removeMember,
} from '../src/lib/teams'
import { createUser } from './helpers'

async function inviteColumns() {
  const rows = await getSql()`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'team_invite'
  `
  return rows.map((row) => String(row.column_name))
}

async function inviteCount() {
  const rows = await getDb().select({ id: teamInvite.id }).from(teamInvite)
  return rows.length
}

async function teamRowCounts(teamId: string) {
  const members = await getDb()
    .select({ userId: teamMember.userId })
    .from(teamMember)
    .where(eq(teamMember.teamId, teamId))
  const invites = await getDb()
    .select({ id: teamInvite.id })
    .from(teamInvite)
    .where(eq(teamInvite.teamId, teamId))
  return { members: members.length, invites: invites.length }
}

async function httpError(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('expected HttpError')
}

describe('teams', () => {
  it('stores invites by account id and never matches a later signup by email', async () => {
    const owner = await createUser('Owner')
    const invited = await createUser('Invited')
    const created = await createTeam(owner.user.id, 'Northwind')
    const spaceRows = await getDb()
      .select()
      .from(space)
      .where(eq(space.teamId, created.id))
    expect(spaceRows).toHaveLength(1)
    expect(spaceRows[0]?.kind).toBe('team')
    expect(spaceRows[0]?.id).toBe(created.spaceId)

    const columns = await inviteColumns()
    expect(columns).toContain('invitee_user_id')
    expect(columns).not.toContain('email')

    const before = await inviteCount()
    await expect(
      lookupAccount(owner.user.id, created.id, 'nobody@example.com'),
    ).rejects.toMatchObject({
      status: 404,
      message: NO_ACCOUNT,
    } satisfies Partial<HttpError>)
    expect(await inviteCount()).toBe(before)

    const looked = await lookupAccount(
      owner.user.id,
      created.id,
      invited.user.email.toUpperCase(),
    )
    expect(looked.id).toBe(invited.user.id)
    expect(await inviteCount()).toBe(before)

    const invite = await createInvite(owner.user.id, created.id, looked.id)
    const stored = await getDb()
      .select()
      .from(teamInvite)
      .where(eq(teamInvite.id, invite.id))
    expect(stored[0]?.inviteeUserId).toBe(invited.user.id)
    expect(stored[0]).not.toHaveProperty('email')

    const oldEmail = invited.user.email
    await getDb()
      .update(user)
      .set({ email: `renamed-${invited.user.id}@example.com` })
      .where(eq(user.id, invited.user.id))
    const imposter = await createUser('Imposter', oldEmail)
    expect(await listInvitations(imposter.user.id)).toEqual([])
    await expect(
      acceptInvite(imposter.user.id, invite.id),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
    await expect(
      declineInvite(imposter.user.id, invite.id),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
    const still = await getDb()
      .select()
      .from(teamInvite)
      .where(eq(teamInvite.id, invite.id))
    expect(still[0]?.status).toBe('pending')
    expect(still[0]?.inviteeUserId).toBe(invited.user.id)

    const accepted = await acceptInvite(invited.user.id, invite.id)
    expect(accepted.spaceId).toBe(created.spaceId)
    await expect(
      assertAccess(invited.user.id, { spaceId: created.spaceId }),
    ).resolves.toMatchObject({
      role: 'member',
    })
  })

  it('lets only the invited account accept or decline', async () => {
    const owner = await createUser('Owner')
    const invited = await createUser('Invited')
    const other = await createUser('Other')
    const created = await createTeam(owner.user.id, 'Access')
    const invite = await createInvite(
      owner.user.id,
      created.id,
      invited.user.id,
    )
    await expect(acceptInvite(other.user.id, invite.id)).rejects.toMatchObject({
      status: 404,
    })
    await expect(declineInvite(owner.user.id, invite.id)).rejects.toMatchObject(
      { status: 404 },
    )
    await expect(
      declineInvite(other.user.id, 'missing-invite'),
    ).rejects.toMatchObject({ status: 404 })
    const pending = await getDb()
      .select()
      .from(teamInvite)
      .where(eq(teamInvite.id, invite.id))
    expect(pending[0]?.status).toBe('pending')
    await expect(declineInvite(invited.user.id, invite.id)).resolves.toEqual({
      ok: true,
    })
    await expect(
      acceptInvite(invited.user.id, invite.id),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('returns the same 404 for a non-member as for a missing team resource', async () => {
    const owner = await createUser('Owner')
    const member = await createUser('Member')
    const outsider = await createUser('Outsider')
    const created = await createTeam(owner.user.id, 'Hidden')
    await acceptInvite(
      member.user.id,
      (await createInvite(owner.user.id, created.id, member.user.id)).id,
    )
    const page = await createPage(owner.user.id, {
      spaceId: created.spaceId,
      title: 'Secret',
    })

    const missingPage = await getPageView(owner.user.id, 'missing-page').then(
      () => null,
      (error: HttpError) => error,
    )
    const deniedPage = await getPageView(outsider.user.id, page.id).then(
      () => null,
      (error: HttpError) => error,
    )
    expect(deniedPage?.status).toBe(404)
    expect(deniedPage?.status).toBe(missingPage?.status)
    expect(deniedPage?.message).toBe(missingPage?.message)

    const missingTree = await listPageTree(owner.user.id, 'missing-space').then(
      () => null,
      (error: HttpError) => error,
    )
    const deniedTree = await listPageTree(
      outsider.user.id,
      created.spaceId,
    ).then(
      () => null,
      (error: HttpError) => error,
    )
    expect(deniedTree?.status).toBe(missingTree?.status)
    expect(deniedTree?.message).toBe(missingTree?.message)

    const missingTeam = await getTeamSettings(
      member.user.id,
      'missing-team',
    ).then(
      () => null,
      (error: HttpError) => error,
    )
    const deniedTeam = await getTeamSettings(outsider.user.id, created.id).then(
      () => null,
      (error: HttpError) => error,
    )
    expect(deniedTeam?.status).toBe(404)
    expect(deniedTeam?.status).toBe(missingTeam?.status)
    expect(deniedTeam?.message).toBe(missingTeam?.message)

    await expect(
      listMentionCandidates(outsider.user.id, created.spaceId, ''),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
    await expect(
      listMentionCandidates(member.user.id, 'missing-space', ''),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
  })

  it('returns the same 404 for a non-member write as for a missing resource', async () => {
    const owner = await createUser('Owner')
    const outsider = await createUser('Outsider')
    const created = await createTeam(owner.user.id, 'Hidden writes')
    const page = await createPage(owner.user.id, {
      spaceId: created.spaceId,
      title: 'Secret',
    })
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] }
    const pairs: Array<
      [string, () => Promise<unknown>, () => Promise<unknown>]
    > = [
      [
        'createPage',
        () =>
          createPage(outsider.user.id, {
            spaceId: created.spaceId,
            title: 'Nope',
          }),
        () =>
          createPage(owner.user.id, {
            spaceId: 'missing-space',
            title: 'Nope',
          }),
      ],
      [
        'savePage',
        () =>
          savePage(outsider.user.id, {
            pageId: page.id,
            title: 'Stolen',
            body: doc,
          }),
        () =>
          savePage(owner.user.id, {
            pageId: 'missing-page',
            title: 'Stolen',
            body: doc,
          }),
      ],
      [
        'renamePage',
        () =>
          renamePage(outsider.user.id, { pageId: page.id, title: 'Stolen' }),
        () =>
          renamePage(owner.user.id, {
            pageId: 'missing-page',
            title: 'Stolen',
          }),
      ],
      [
        'movePage',
        () => movePage(outsider.user.id, { pageId: page.id, parentId: null }),
        () =>
          movePage(owner.user.id, { pageId: 'missing-page', parentId: null }),
      ],
      [
        'archivePage',
        () => archivePage(outsider.user.id, page.id),
        () => archivePage(owner.user.id, 'missing-page'),
      ],
      [
        'lookupAccount',
        () => lookupAccount(outsider.user.id, created.id, outsider.user.email),
        () => lookupAccount(owner.user.id, 'missing-team', outsider.user.email),
      ],
      [
        'createInvite',
        () => createInvite(outsider.user.id, created.id, outsider.user.id),
        () => createInvite(owner.user.id, 'missing-team', outsider.user.id),
      ],
      [
        'removeMember',
        () => removeMember(outsider.user.id, created.id, owner.user.id),
        () => removeMember(owner.user.id, 'missing-team', owner.user.id),
      ],
      [
        'deleteTeam',
        () => deleteTeam(outsider.user.id, created.id),
        () => deleteTeam(owner.user.id, 'missing-team'),
      ],
      [
        'getTeamSettings',
        () => getTeamSettings(outsider.user.id, created.id),
        () => getTeamSettings(owner.user.id, 'missing-team'),
      ],
    ]
    for (const [name, denied, missing] of pairs) {
      const deniedError = await httpError(denied)
      const missingError = await httpError(missing)
      expect(deniedError.status, name).toBe(404)
      expect(deniedError.message, name).toBe('Not found')
      expect(deniedError.status, name).toBe(missingError.status)
      expect(deniedError.message, name).toBe(missingError.message)
    }
    const still = await getPageView(owner.user.id, page.id)
    expect(still.title).toBe('Secret')
    await expect(
      getTeamSettings(owner.user.id, created.id),
    ).resolves.toMatchObject({ role: 'owner' })
  })

  it('stops a removed member on the next read and save', async () => {
    const owner = await createUser('Owner')
    const member = await createUser('Member')
    const created = await createTeam(owner.user.id, 'Editors')
    await acceptInvite(
      member.user.id,
      (await createInvite(owner.user.id, created.id, member.user.id)).id,
    )
    const page = await createPage(member.user.id, {
      spaceId: created.spaceId,
      title: 'Shared',
    })
    const before = await getPageView(member.user.id, page.id)
    await removeMember(owner.user.id, created.id, member.user.id)
    await expect(getPageView(member.user.id, page.id)).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
    await expect(
      listPageTree(member.user.id, created.spaceId),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      savePage(member.user.id, {
        pageId: page.id,
        title: 'Stolen',
        body: { type: 'doc', content: [{ type: 'paragraph' }] },
      }),
    ).rejects.toMatchObject({ status: 404, message: 'Not found' })
    const after = await getPageView(owner.user.id, page.id)
    expect(after.title).toBe(before.title)
    expect(after.body).toEqual(before.body)
  })

  it('refuses invite, remove, and delete from a member', async () => {
    const owner = await createUser('Owner')
    const member = await createUser('Member')
    const extra = await createUser('Extra')
    const created = await createTeam(owner.user.id, 'Roles')
    await acceptInvite(
      member.user.id,
      (await createInvite(owner.user.id, created.id, member.user.id)).id,
    )
    const before = await inviteCount()
    await expect(
      lookupAccount(member.user.id, created.id, extra.user.email),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    })
    await expect(
      createInvite(member.user.id, created.id, extra.user.id),
    ).rejects.toMatchObject({
      status: 403,
    })
    expect(await inviteCount()).toBe(before)
    await expect(
      removeMember(member.user.id, created.id, owner.user.id),
    ).rejects.toMatchObject({
      status: 403,
    })
    await expect(deleteTeam(member.user.id, created.id)).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      getTeamSettings(owner.user.id, created.id),
    ).resolves.toMatchObject({
      role: 'owner',
    })
    await expect(
      assertAccess(member.user.id, { spaceId: created.spaceId }),
    ).resolves.toMatchObject({
      role: 'member',
    })
  })

  it('refuses a member removing another member and leaves this team unchanged', async () => {
    const owner = await createUser('Owner')
    const member = await createUser('Member')
    const other = await createUser('Other')
    const created = await createTeam(owner.user.id, 'Roster')
    await acceptInvite(
      member.user.id,
      (await createInvite(owner.user.id, created.id, member.user.id)).id,
    )
    await acceptInvite(
      other.user.id,
      (await createInvite(owner.user.id, created.id, other.user.id)).id,
    )
    const before = await teamRowCounts(created.id)
    expect(before).toEqual({ members: 3, invites: 2 })
    await expect(
      removeMember(member.user.id, created.id, other.user.id),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    })
    expect(await teamRowCounts(created.id)).toEqual(before)
    await expect(
      assertAccess(other.user.id, { spaceId: created.spaceId }),
    ).resolves.toMatchObject({ role: 'member' })
  })

  it('scopes mentions to the space and never puts a non-member email on a chip', async () => {
    const owner = await createUser('Sam')
    const teammate = await createUser('Ada West')
    const outsider = await createUser('Samantha')
    const created = await createTeam(owner.user.id, 'Mentions')
    await acceptInvite(
      teammate.user.id,
      (await createInvite(owner.user.id, created.id, teammate.user.id)).id,
    )

    const personal = await listMentionCandidates(
      owner.user.id,
      owner.space.id,
      'Sam',
    )
    expect(personal).toEqual([{ id: owner.user.id, name: 'Sam' }])
    expect(JSON.stringify(personal)).not.toContain(outsider.user.email)

    const teamList = await listMentionCandidates(
      teammate.user.id,
      created.spaceId,
      '',
    )
    expect(teamList.map((person) => person.id).sort()).toEqual(
      [owner.user.id, teammate.user.id].sort(),
    )
    expect(teamList.some((person) => person.id === outsider.user.id)).toBe(
      false,
    )
    for (const person of teamList) {
      expect(Object.keys(person).sort()).toEqual(['id', 'name'])
      expect(JSON.stringify(person)).not.toContain('@')
    }

    const page = await createPage(owner.user.id, {
      spaceId: created.spaceId,
      title: 'Notes',
    })
    const body = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: { id: teammate.user.id, label: teammate.user.email },
            },
          ],
        },
      ],
    }
    await savePage(owner.user.id, { pageId: page.id, title: 'Notes', body })
    await removeMember(owner.user.id, created.id, teammate.user.id)
    const view = await getPageView(owner.user.id, page.id)
    const person =
      view.people.find((item) => item.id === teammate.user.id) ?? null
    expect(person?.member).toBe(false)
    expect(JSON.stringify(view.people)).not.toContain(teammate.user.email)
    expect(mentionChipText(person, teammate.user.email)).toBe('Former member')
    expect(mentionChipText(person, teammate.user.email)).not.toContain('@')
    expect(mentionChipText(person, teammate.user.email)).not.toContain(
      teammate.user.name,
    )
    expect(mentionChipText(null, outsider.user.email)).toBe('Unknown person')
    expect(mentionChipText(null, outsider.user.name)).toBe('Unknown person')
    expect(mentionChipText(null, outsider.user.email)).not.toContain('@')
    expect(mentionChipText(null, outsider.user.name)).not.toContain(
      outsider.user.name,
    )
    expect(
      mentionChipText(
        { id: teammate.user.id, name: teammate.user.email, member: false },
        teammate.user.email,
      ),
    ).toBe('Former member')

    const spaceRows = await getDb()
      .select()
      .from(space)
      .where(eq(space.id, created.spaceId))
    const resolved = await peopleForBody(spaceRows[0]!, body)
    expect(resolved.find((item) => item.id === teammate.user.id)?.member).toBe(
      false,
    )
    expect(JSON.stringify(resolved)).not.toContain(teammate.user.email)
  })

  it('treats a teammate from the @ list as a current member before reload', () => {
    const listed = [{ id: 'bea', name: 'Bea Member' }]
    const fresh = mentionPerson('bea', [], listed)
    expect(fresh).toEqual({ id: 'bea', name: 'Bea Member', member: true })
    expect(mentionChipText(fresh, 'bea@example.com')).toBe('Bea Member')

    const afterReload = mentionPerson(
      'bea',
      [{ id: 'bea', name: 'Bea Member', member: true }],
      [],
    )
    expect(afterReload?.member).toBe(true)

    const former = mentionPerson(
      'ada',
      [{ id: 'ada', name: 'Ada West', member: false }],
      [],
    )
    expect(former).toEqual({ id: 'ada', name: 'Ada West', member: false })
    expect(mentionChipText(former, 'ada@example.com')).toBe('Former member')
    expect(mentionChipText(former, 'ada@example.com')).not.toContain('@')
    expect(mentionChipText(former, 'ada@example.com')).not.toContain('Ada')

    expect(mentionPerson('outsider', [], [])).toBeNull()
    expect(mentionChipText(null, 'Outsider Secret Name')).toBe('Unknown person')
    expect(mentionChipText(null, 'outsider@example.com')).toBe('Unknown person')
    expect(mentionChipText(null, 'Outsider Secret Name')).not.toContain(
      'Outsider',
    )
    expect(mentionChipText(null, 'outsider@example.com')).not.toContain('@')
  })

  it('refreshes the cached @ list and hides outsiders', () => {
    const cache = createMentionCache()
    cache.replace([{ id: 'ada', name: 'Ada West' }])
    expect(cache.person('ada', [])).toEqual({
      id: 'ada',
      name: 'Ada West',
      member: true,
    })

    cache.replace([])
    expect(cache.person('ada', [])).toBeNull()

    cache.replace([{ id: 'ada', name: 'Ada West' }])
    const removed = cache.person('ada', [
      { id: 'ada', name: 'Ada West', member: false },
    ])
    expect(removed).toEqual({ id: 'ada', name: 'Ada West', member: false })
    expect(mentionChipText(removed, 'ada@example.com')).toBe('Former member')
    expect(mentionChipText(removed, 'ada@example.com')).not.toContain('Ada')
    expect(mentionChipText(removed, 'ada@example.com')).not.toContain('@')

    cache.clear()
    expect(cache.person('ada', [])).toBeNull()
    expect(
      mentionChipText(cache.person('missing', []), 'secret@example.com'),
    ).toBe('Unknown person')
    expect(mentionChipText(null, 'Outsider Secret Name')).not.toContain(
      'Outsider',
    )
    expect(mentionChipText(null, 'secret@example.com')).not.toContain('@')
  })

  it('names only current and former members of that space', async () => {
    const owner = await createUser('Owner')
    const teammate = await createUser('Ada West')
    const outsider = await createUser('Outsider Secret Name')
    const created = await createTeam(owner.user.id, 'Names')
    await acceptInvite(
      teammate.user.id,
      (await createInvite(owner.user.id, created.id, teammate.user.id)).id,
    )
    const page = await createPage(owner.user.id, {
      spaceId: created.spaceId,
      title: 'Notes',
    })
    const mention = (id: string, label: string) => ({
      type: 'mention',
      attrs: { id, label },
    })
    const body = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            mention(owner.user.id, owner.user.email),
            mention(teammate.user.id, teammate.user.email),
            mention(outsider.user.id, outsider.user.name),
          ],
        },
      ],
    }
    await savePage(owner.user.id, { pageId: page.id, title: 'Notes', body })
    await removeMember(owner.user.id, created.id, teammate.user.id)
    const spaceRows = await getDb()
      .select()
      .from(space)
      .where(eq(space.id, created.spaceId))
    const resolved = await peopleForBody(spaceRows[0]!, body)
    expect(resolved.find((item) => item.id === owner.user.id)).toEqual({
      id: owner.user.id,
      name: 'Owner',
      member: true,
    })
    expect(resolved.find((item) => item.id === teammate.user.id)).toEqual({
      id: teammate.user.id,
      name: 'Ada West',
      member: false,
    })
    expect(
      resolved.find((item) => item.id === outsider.user.id),
    ).toBeUndefined()
    const rendered = JSON.stringify(resolved)
    expect(rendered).not.toContain('Outsider Secret Name')
    expect(rendered).not.toContain(outsider.user.email)
    expect(rendered).not.toContain('@')

    const personal = await peopleForBody(owner.space, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            mention(owner.user.id, owner.user.name),
            mention(outsider.user.id, outsider.user.name),
          ],
        },
      ],
    })
    expect(personal).toEqual([
      { id: owner.user.id, name: 'Owner', member: true },
    ])
    expect(JSON.stringify(personal)).not.toContain('Outsider Secret Name')
    expect(JSON.stringify(personal)).not.toContain(outsider.user.email)
  })
})
