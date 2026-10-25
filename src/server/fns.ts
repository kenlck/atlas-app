import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import type { Json } from '#/lib/body-text'
import { getDb } from '#/lib/db'
import { HttpError } from '#/lib/http'
import { user } from '#/lib/schema'
import { eq } from 'drizzle-orm'
import { openCalendar } from '#/lib/calendar'
import { listMentionCandidates } from '#/lib/mentions'
import {
  archivePage,
  createPage,
  getPageView,
  getPersonalSpace,
  listPageTree,
  movePage,
  renamePage,
  savePage,
} from '#/lib/pages'
import { searchVisiblePages } from '#/lib/search'
import {
  acceptInvite,
  countPendingInvites,
  createInvite,
  createTeam,
  declineInvite,
  deleteTeam,
  getTeamSettingsForSpace,
  listInvitations,
  listMySpaces,
  lookupAccount,
  removeMember,
} from '#/lib/teams'
import { listApiTokens } from '#/lib/api-tokens'
import { setNewPassword } from '#/lib/password'
import {
  readSession,
  requireSession,
  requireUnlockedSession,
} from '#/lib/session'

function rethrow(error: unknown): never {
  if (error instanceof HttpError) {
    setResponseStatus(error.status)
  }
  throw error
}

const unlocked = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    try {
      const session = await requireUnlockedSession()
      return next({ context: { userId: session.user.id, user: session.user } })
    } catch (error) {
      rethrow(error)
    }
  },
)

const signedIn = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    try {
      const session = await requireSession()
      return next({ context: { userId: session.user.id, user: session.user } })
    } catch (error) {
      rethrow(error)
    }
  },
)

export const fetchSession = createServerFn({ method: 'GET' }).handler(
  async () => {
    const session = await readSession()
    if (!session) return null
    const rows = await getDb()
      .select({ mustChangePassword: user.mustChangePassword, name: user.name })
      .from(user)
      .where(eq(user.id, session.user.id))
      .limit(1)
    return {
      user: {
        id: session.user.id,
        name: rows[0]?.name ?? session.user.name,
        email: session.user.email,
        mustChangePassword: Boolean(rows[0]?.mustChangePassword),
      },
    }
  },
)

export const fetchPersonalSpace = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .handler(async ({ context }) => {
    try {
      return await getPersonalSpace(context.userId)
    } catch (error) {
      rethrow(error)
    }
  })

export const fetchPageTree = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .validator((data: { spaceId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      const listed = await listPageTree(context.userId, data.spaceId)
      const [spaces, pendingInvites] = await Promise.all([
        listMySpaces(context.userId),
        countPendingInvites(context.userId),
      ])
      return { ...listed, spaces, pendingInvites }
    } catch (error) {
      rethrow(error)
    }
  })

export const fetchCalendar = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .validator((data: { spaceId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await openCalendar(context.userId, data.spaceId)
    } catch (error) {
      rethrow(error)
    }
  })

export const searchPagesFn = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .validator((data: { query: string }) => {
    if (typeof data.query !== 'string') throw new Error('Bad request')
    return { query: data.query }
  })
  .handler(async ({ data, context }) => {
    try {
      const hits = await searchVisiblePages(context.userId, data.query, {
        limit: 21,
      })
      return { hits }
    } catch (error) {
      rethrow(error)
    }
  })

export const fetchPage = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .validator((data: { pageId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await getPageView(context.userId, data.pageId)
    } catch (error) {
      rethrow(error)
    }
  })

export const createPageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator(
    (data: { spaceId: string; parentId?: string | null; title?: string }) =>
      data,
  )
  .handler(async ({ data, context }) => {
    try {
      return await createPage(context.userId, data)
    } catch (error) {
      rethrow(error)
    }
  })

export const renamePageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { pageId: string; title: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await renamePage(context.userId, data)
    } catch (error) {
      rethrow(error)
    }
  })

export const savePageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { pageId: string; title: string; body: Json }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await savePage(context.userId, data)
    } catch (error) {
      rethrow(error)
    }
  })

export const movePageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { pageId: string; parentId: string | null }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await movePage(context.userId, data)
    } catch (error) {
      rethrow(error)
    }
  })

export const archivePageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { pageId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await archivePage(context.userId, data.pageId)
    } catch (error) {
      rethrow(error)
    }
  })

export const fetchTeamSettings = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .validator((data: { spaceId: string; screen: string }) => {
    if (data.screen !== 'members') throw new Error('Bad request')
    return { spaceId: data.spaceId, screen: 'members' as const }
  })
  .handler(async ({ data, context }) => {
    try {
      return await getTeamSettingsForSpace(context.userId, data.spaceId)
    } catch (error) {
      rethrow(error)
    }
  })

export const fetchInvitations = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .validator((data: { screen: string }) => {
    if (data.screen !== 'invitations') throw new Error('Bad request')
    return { screen: 'invitations' as const }
  })
  .handler(async ({ context }) => {
    try {
      return { invites: await listInvitations(context.userId) }
    } catch (error) {
      rethrow(error)
    }
  })

export const fetchTokens = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .handler(async ({ context }) => {
    try {
      return { tokens: await listApiTokens(context.userId) }
    } catch (error) {
      rethrow(error)
    }
  })

export const fetchMentionCandidates = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .validator((data: { spaceId: string; mentionQuery: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await listMentionCandidates(
        context.userId,
        data.spaceId,
        data.mentionQuery,
      )
    } catch (error) {
      rethrow(error)
    }
  })

export const createTeamFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { name: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await createTeam(context.userId, data.name)
    } catch (error) {
      rethrow(error)
    }
  })

export const lookupAccountFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { teamId: string; email: string; screen: string }) => {
    if (data.screen !== 'lookup') throw new Error('Bad request')
    return {
      teamId: data.teamId,
      email: data.email,
      screen: 'lookup' as const,
    }
  })
  .handler(async ({ data, context }) => {
    try {
      return await lookupAccount(context.userId, data.teamId, data.email)
    } catch (error) {
      rethrow(error)
    }
  })

export const createInviteFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { teamId: string; userId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await createInvite(context.userId, data.teamId, data.userId)
    } catch (error) {
      rethrow(error)
    }
  })

export const acceptInviteFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { inviteId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await acceptInvite(context.userId, data.inviteId)
    } catch (error) {
      rethrow(error)
    }
  })

export const declineInviteFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { inviteId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await declineInvite(context.userId, data.inviteId)
    } catch (error) {
      rethrow(error)
    }
  })

export const removeMemberFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { teamId: string; userId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await removeMember(context.userId, data.teamId, data.userId)
    } catch (error) {
      rethrow(error)
    }
  })

export const deleteTeamFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { teamId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await deleteTeam(context.userId, data.teamId)
    } catch (error) {
      rethrow(error)
    }
  })

export const changePasswordFn = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((data: { password: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await setNewPassword(context.userId, data.password)
    } catch (error) {
      rethrow(error)
    }
  })
