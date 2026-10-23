import { and, asc, count, eq, sql } from 'drizzle-orm'
import { assertAccess, type SpaceRole } from './access'
import { getDb } from './db'
import { forbiddenRole, HttpError, notFound } from './http'
import { newId } from './ids'
import { NO_ACCOUNT } from './invite-copy'
import { space, team, teamInvite, teamMember, user } from './schema'

export { NO_ACCOUNT }

export type SpaceSummary = {
  id: string
  name: string
  kind: 'personal' | 'team'
  role: SpaceRole
}

export type InvitationCard = {
  id: string
  teamId: string
  teamName: string
  invitedByName: string
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

async function teamSpace(teamId: string) {
  const db = getDb()
  const rows = await db
    .select()
    .from(space)
    .where(eq(space.teamId, teamId))
    .limit(1)
  return rows[0] ?? null
}

export async function assertTeamAccess(userId: string, teamId: string) {
  const spaceRow = await teamSpace(teamId)
  if (!spaceRow) notFound()
  const access = await assertAccess(userId, { spaceId: spaceRow.id })
  if (access.role === 'personal') notFound()
  return { space: access.space, role: access.role }
}

export async function assertTeamOwner(userId: string, teamId: string) {
  const access = await assertTeamAccess(userId, teamId)
  if (access.role !== 'owner') forbiddenRole()
  return access
}

export async function createTeam(userId: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new HttpError(400, 'Team name is required')
  if (trimmed.length > 80) throw new HttpError(400, 'Team name is too long')
  const db = getDb()
  const teamId = newId()
  const spaceId = newId()
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx.insert(team).values({ id: teamId, name: trimmed, createdAt: now })
    await tx.insert(teamMember).values({
      teamId,
      userId,
      role: 'owner',
      createdAt: now,
    })
    await tx.insert(space).values({
      id: spaceId,
      kind: 'team',
      teamId,
      ownerUserId: null,
      name: trimmed,
      createdAt: now,
    })
  })
  return { id: teamId, spaceId, name: trimmed }
}

export async function lookupAccount(
  actorId: string,
  teamId: string,
  email: string,
) {
  await assertTeamOwner(actorId, teamId)
  const normalized = normalizeEmail(email)
  if (!normalized) throw new HttpError(404, NO_ACCOUNT)
  const db = getDb()
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalized}`)
    .limit(1)
  const found = rows[0]
  if (!found) throw new HttpError(404, NO_ACCOUNT)
  return { id: found.id, name: found.name, email: found.email }
}

export async function createInvite(
  actorId: string,
  teamId: string,
  inviteeUserId: string,
) {
  await assertTeamOwner(actorId, teamId)
  const db = getDb()
  const people = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, inviteeUserId))
    .limit(1)
  if (!people[0]) notFound()
  const existingMember = await db
    .select({ userId: teamMember.userId })
    .from(teamMember)
    .where(
      and(eq(teamMember.teamId, teamId), eq(teamMember.userId, inviteeUserId)),
    )
    .limit(1)
  if (existingMember[0]) throw new HttpError(409, 'Already a member')
  const pending = await db
    .select({ id: teamInvite.id })
    .from(teamInvite)
    .where(
      and(
        eq(teamInvite.teamId, teamId),
        eq(teamInvite.inviteeUserId, inviteeUserId),
        eq(teamInvite.status, 'pending'),
      ),
    )
    .limit(1)
  if (pending[0]) return { id: pending[0].id, teamId, inviteeUserId }
  const id = newId()
  await db.insert(teamInvite).values({
    id,
    teamId,
    inviteeUserId,
    invitedBy: actorId,
    status: 'pending',
    createdAt: new Date(),
  })
  return { id, teamId, inviteeUserId }
}

export async function acceptInvite(userId: string, inviteId: string) {
  const db = getDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from team_invite where id = ${inviteId} for update`,
    )
    const rows = await tx
      .select()
      .from(teamInvite)
      .where(eq(teamInvite.id, inviteId))
      .limit(1)
    const invite = rows[0]
    if (
      !invite ||
      invite.status !== 'pending' ||
      invite.inviteeUserId !== userId
    )
      notFound()
    await tx.insert(teamMember).values({
      teamId: invite.teamId,
      userId,
      role: 'member',
      createdAt: new Date(),
    })
    await tx
      .update(teamInvite)
      .set({ status: 'accepted' })
      .where(eq(teamInvite.id, invite.id))
    const spaces = await tx
      .select({ id: space.id })
      .from(space)
      .where(eq(space.teamId, invite.teamId))
      .limit(1)
    if (!spaces[0]) notFound()
    return { teamId: invite.teamId, spaceId: spaces[0].id }
  })
}

export async function declineInvite(userId: string, inviteId: string) {
  const db = getDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from team_invite where id = ${inviteId} for update`,
    )
    const rows = await tx
      .select()
      .from(teamInvite)
      .where(eq(teamInvite.id, inviteId))
      .limit(1)
    const invite = rows[0]
    if (
      !invite ||
      invite.status !== 'pending' ||
      invite.inviteeUserId !== userId
    )
      notFound()
    await tx
      .update(teamInvite)
      .set({ status: 'declined' })
      .where(eq(teamInvite.id, invite.id))
  })
  return { ok: true as const }
}

export async function removeMember(
  actorId: string,
  teamId: string,
  memberUserId: string,
) {
  await assertTeamOwner(actorId, teamId)
  const db = getDb()
  const rows = await db
    .select({ role: teamMember.role })
    .from(teamMember)
    .where(
      and(eq(teamMember.teamId, teamId), eq(teamMember.userId, memberUserId)),
    )
    .limit(1)
  const target = rows[0]
  if (!target) notFound()
  if (target.role === 'owner')
    throw new HttpError(400, 'Cannot remove the owner')
  await db
    .delete(teamMember)
    .where(
      and(eq(teamMember.teamId, teamId), eq(teamMember.userId, memberUserId)),
    )
  return { ok: true as const }
}

export async function deleteTeam(actorId: string, teamId: string) {
  await assertTeamOwner(actorId, teamId)
  const db = getDb()
  await db.delete(team).where(eq(team.id, teamId))
  return { ok: true as const }
}

export async function getTeamSettings(userId: string, teamId: string) {
  const access = await assertTeamAccess(userId, teamId)
  const db = getDb()
  const members = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: teamMember.role,
    })
    .from(teamMember)
    .innerJoin(user, eq(user.id, teamMember.userId))
    .where(eq(teamMember.teamId, teamId))
  members.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'owner' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const invites =
    access.role === 'owner'
      ? await db
          .select({
            id: teamInvite.id,
            inviteeUserId: teamInvite.inviteeUserId,
            name: user.name,
            email: user.email,
          })
          .from(teamInvite)
          .innerJoin(user, eq(user.id, teamInvite.inviteeUserId))
          .where(
            and(
              eq(teamInvite.teamId, teamId),
              eq(teamInvite.status, 'pending'),
            ),
          )
          .orderBy(asc(teamInvite.createdAt))
      : []
  return {
    teamId,
    spaceId: access.space.id,
    name: access.space.name,
    role: access.role,
    members,
    invites,
  }
}

export async function getTeamSettingsForSpace(userId: string, spaceId: string) {
  const access = await assertAccess(userId, { spaceId })
  if (access.space.kind !== 'team' || !access.space.teamId) notFound()
  return getTeamSettings(userId, access.space.teamId)
}

export async function listMySpaces(userId: string): Promise<SpaceSummary[]> {
  const db = getDb()
  const personal = await db
    .select({ id: space.id, name: space.name })
    .from(space)
    .where(and(eq(space.kind, 'personal'), eq(space.ownerUserId, userId)))
    .limit(1)
  const teams = await db
    .select({
      id: space.id,
      name: space.name,
      role: teamMember.role,
    })
    .from(teamMember)
    .innerJoin(space, eq(space.teamId, teamMember.teamId))
    .where(eq(teamMember.userId, userId))
    .orderBy(asc(space.name))
  const mine: SpaceSummary[] = []
  if (personal[0]) {
    mine.push({
      id: personal[0].id,
      name: personal[0].name,
      kind: 'personal',
      role: 'personal',
    })
  }
  for (const row of teams) {
    mine.push({ id: row.id, name: row.name, kind: 'team', role: row.role })
  }
  return mine
}

export async function countPendingInvites(userId: string) {
  const db = getDb()
  const rows = await db
    .select({ value: count() })
    .from(teamInvite)
    .where(
      and(
        eq(teamInvite.inviteeUserId, userId),
        eq(teamInvite.status, 'pending'),
      ),
    )
  return Number(rows[0]?.value ?? 0)
}

export async function listInvitations(
  userId: string,
): Promise<InvitationCard[]> {
  const db = getDb()
  const inviter = user
  const rows = await db
    .select({
      id: teamInvite.id,
      teamId: team.id,
      teamName: team.name,
      invitedByName: inviter.name,
    })
    .from(teamInvite)
    .innerJoin(team, eq(team.id, teamInvite.teamId))
    .innerJoin(inviter, eq(inviter.id, teamInvite.invitedBy))
    .where(
      and(
        eq(teamInvite.inviteeUserId, userId),
        eq(teamInvite.status, 'pending'),
      ),
    )
    .orderBy(asc(teamInvite.createdAt))
  return rows
}
