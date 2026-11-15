import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import { getDb } from '#/lib/db'
import { HttpError } from '#/lib/http'
import { assertPageTitle, parseSavePayload } from '#/lib/page-input'
import { user } from '#/lib/schema'
import { eq } from 'drizzle-orm'
import { openCalendar } from '#/lib/calendar'
import { listMentionCandidates } from '#/lib/mentions'
import {
  archivePage,
  cloneDiagram,
  createDiagram,
  createPage,
  getPageView,
  listPageTree,
  movePage,
  renamePage,
  savePage,
} from '#/lib/pages'
import { searchVisiblePages } from '#/lib/search'
import { getDefaultSpace, touchLastSpace } from '#/lib/spaces'
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

export const fetchDefaultSpace = createServerFn({ method: 'GET' })
  .middleware([unlocked])
  .handler(async ({ context }) => {
    try {
      return await getDefaultSpace(context.userId)
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
      await touchLastSpace(context.userId, listed.space.id)
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
  .validator((data: unknown) => data)
  .handler(async ({ data, context }) => {
    try {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new HttpError(400, 'Bad request')
      }
      const record = data as Record<string, unknown>
      const spaceId = record.spaceId
      if (typeof spaceId !== 'string' || spaceId.length === 0) {
        throw new HttpError(400, 'Bad request')
      }
      const parentRaw = record.parentId
      let parentId: string | null | undefined
      if (parentRaw === undefined || parentRaw === null || typeof parentRaw === 'string') {
        parentId = parentRaw
      } else {
        throw new HttpError(400, 'Bad request')
      }
      const title = record.title === undefined ? undefined : assertPageTitle(record.title)
      let kind: 'doc' | 'whiteboard' | undefined
      if (record.kind === undefined) kind = undefined
      else if (record.kind === 'doc' || record.kind === 'whiteboard') kind = record.kind
      else throw new HttpError(400, 'Bad request')
      const view = await createPage(context.userId, { spaceId, parentId, title, kind })
      await touchLastSpace(context.userId, view.spaceId)
      return view
    } catch (error) {
      rethrow(error)
    }
  })

export const renamePageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }) => {
    try {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new HttpError(400, 'Bad request')
      }
      const record = data as Record<string, unknown>
      const pageId = record.pageId
      if (typeof pageId !== 'string' || pageId.length === 0) {
        throw new HttpError(400, 'Bad request')
      }
      const view = await renamePage(context.userId, {
        pageId,
        title: assertPageTitle(record.title),
      })
      await touchLastSpace(context.userId, view.spaceId)
      return view
    } catch (error) {
      rethrow(error)
    }
  })

export const savePageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }) => {
    try {
      const parsed = parseSavePayload(data)
      if (!parsed) throw new HttpError(400, 'Bad request')
      const stamp =
        data !== null && typeof data === 'object' && !Array.isArray(data)
          ? (data as { updatedAt?: unknown }).updatedAt
          : undefined
      if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) {
        throw new HttpError(400, 'Bad request')
      }
      const view = await savePage(context.userId, {
        pageId: parsed.pageId,
        title: assertPageTitle(parsed.title),
        body: parsed.body,
        updatedAt: stamp,
      })
      await touchLastSpace(context.userId, view.spaceId)
      return view
    } catch (error) {
      rethrow(error)
    }
  })

export const createDiagramFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { pageId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await createDiagram(context.userId, data.pageId)
    } catch (error) {
      rethrow(error)
    }
  })

export const cloneDiagramFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: { pageId: string; drawingId: string }) => data)
  .handler(async ({ data, context }) => {
    try {
      return await cloneDiagram(context.userId, data)
    } catch (error) {
      rethrow(error)
    }
  })

export const movePageFn = createServerFn({ method: 'POST' })
  .middleware([unlocked])
  .validator((data: unknown) => data)
  .handler(async ({ data: raw, context }) => {
    try {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HttpError(400, 'Bad request')
      }
      const record = raw as Record<string, unknown>
      const pageId = record.pageId
      const parentId = record.parentId
      if (typeof pageId !== 'string' || pageId.length === 0) {
        throw new HttpError(400, 'Bad request')
      }
      if (typeof parentId !== 'string' && parentId !== null) {
        throw new HttpError(400, 'Bad request')
      }
      const data = { pageId, parentId }
      const view = await movePage(context.userId, data)
      await touchLastSpace(context.userId, view.spaceId)
      return view
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
