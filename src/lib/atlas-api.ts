import { createEvent, deleteEvent, listEvents, updateEvent } from './calendar'
import { searchVisiblePages } from './search'
import { listMentionCandidates } from './mentions'
import {
  acceptInvite,
  createInvite,
  createTeam,
  declineInvite,
  deleteTeam,
  getTeamSettings,
  listInvitations,
  lookupAccount,
  removeMember,
} from './teams'
import { createApiToken, listApiTokens, revokeApiToken } from './api-tokens'
import { HttpError } from './http'
import { requireUnlockedSession } from './session'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function handleAtlasApi(request: Request) {
  try {
    const session = await requireUnlockedSession()
    const userId = session.user.id
    const url = new URL(request.url)
    const rest = url.pathname
      .replace(/\/+$/, '')
      .replace(/^\/api\/atlas\/?/, '')
    const parts = rest.split('/').filter(Boolean)
    const method = request.method.toUpperCase()

    if (method === 'POST' && parts.length === 1 && parts[0] === 'teams') {
      const body = await readJson(request)
      if (typeof body.name !== 'string') throw new HttpError(400, 'Bad request')
      const created = await createTeam(userId, body.name)
      return json(created, 201)
    }

    if (parts[0] === 'teams' && parts.length === 2 && parts[1]) {
      const teamId = parts[1]
      if (method === 'GET') {
        const settings = await getTeamSettings(userId, teamId)
        return json({
          id: settings.teamId,
          name: settings.name,
          spaceId: settings.spaceId,
          role: settings.role,
        })
      }
      if (method === 'DELETE') {
        await deleteTeam(userId, teamId)
        return json({ ok: true })
      }
    }

    if (
      method === 'POST' &&
      parts[0] === 'teams' &&
      parts[2] === 'invites' &&
      parts[3] === 'lookup' &&
      parts[1]
    ) {
      const body = await readJson(request)
      if (typeof body.email !== 'string')
        throw new HttpError(400, 'Bad request')
      const found = await lookupAccount(userId, parts[1], body.email)
      return json({ user: found })
    }

    if (
      method === 'POST' &&
      parts[0] === 'teams' &&
      parts[2] === 'invites' &&
      parts.length === 3 &&
      parts[1]
    ) {
      const body = await readJson(request)
      if (typeof body.userId !== 'string' || !body.userId) {
        throw new HttpError(400, 'Invite requires an account id')
      }
      const invite = await createInvite(userId, parts[1], body.userId)
      return json(invite, 201)
    }

    if (
      method === 'DELETE' &&
      parts[0] === 'teams' &&
      parts[2] === 'members' &&
      parts.length === 4 &&
      parts[1] &&
      parts[3]
    ) {
      await removeMember(userId, parts[1], parts[3])
      return json({ ok: true })
    }

    if (parts[0] === 'teams' && parts[2] === 'calendar' && parts[1]) {
      const teamId = parts[1]
      if (method === 'GET' && parts.length === 3) {
        const events = await listEvents(
          userId,
          teamId,
          url.searchParams.get('month') ?? '',
          url.searchParams.get('timeZone') ?? '',
        )
        return json({ events })
      }
      if (method === 'POST' && parts[3] === 'events' && parts.length === 4) {
        const created = await createEvent(
          userId,
          teamId,
          await readJson(request),
        )
        return json(created, 201)
      }
      if (
        method === 'POST' &&
        parts[3] === 'events' &&
        parts.length === 5 &&
        parts[4]
      ) {
        const updated = await updateEvent(
          userId,
          teamId,
          parts[4],
          await readJson(request),
        )
        return json(updated)
      }
      if (
        method === 'DELETE' &&
        parts[3] === 'events' &&
        parts.length === 5 &&
        parts[4]
      ) {
        await deleteEvent(userId, teamId, parts[4])
        return json({ ok: true })
      }
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'search') {
      const hits = await searchVisiblePages(
        userId,
        url.searchParams.get('q') ?? '',
      )
      return json({ hits })
    }

    if (parts[0] === 'tokens' && parts.length === 1) {
      if (method === 'GET') {
        return json({ tokens: await listApiTokens(userId) })
      }
      if (method === 'POST') {
        const created = await createApiToken(userId, await readJson(request))
        return new Response(JSON.stringify(created), {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        })
      }
    }

    if (
      method === 'DELETE' &&
      parts[0] === 'tokens' &&
      parts.length === 2 &&
      parts[1]
    ) {
      await revokeApiToken(userId, parts[1])
      return json({ ok: true })
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'invites') {
      const invites = await listInvitations(userId)
      return json({ invites })
    }

    if (
      method === 'POST' &&
      parts[0] === 'invites' &&
      parts[2] === 'accept' &&
      parts[1]
    ) {
      const result = await acceptInvite(userId, parts[1])
      return json(result)
    }

    if (
      method === 'POST' &&
      parts[0] === 'invites' &&
      parts[2] === 'decline' &&
      parts[1]
    ) {
      const result = await declineInvite(userId, parts[1])
      return json(result)
    }

    if (
      method === 'GET' &&
      parts[0] === 'spaces' &&
      parts[2] === 'mentionables' &&
      parts[1]
    ) {
      const users = await listMentionCandidates(
        userId,
        parts[1],
        url.searchParams.get('q') ?? '',
      )
      return json({ users })
    }

    throw new HttpError(404, 'Not found')
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status)
    }
    return json({ error: 'Internal Server Error' }, 500)
  }
}
