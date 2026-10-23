import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import type { Json } from '#/lib/body-text'
import { getDb } from '#/lib/db'
import { HttpError } from '#/lib/http'
import { user } from '#/lib/schema'
import { eq } from 'drizzle-orm'
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
import { setNewPassword } from '#/lib/password'
import { readSession, requireSession, requireUnlockedSession } from '#/lib/session'

function rethrow(error: unknown): never {
  if (error instanceof HttpError) {
    setResponseStatus(error.status)
  }
  throw error
}

const unlocked = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try {
    const session = await requireUnlockedSession()
    return next({ context: { userId: session.user.id, user: session.user } })
  } catch (error) {
    rethrow(error)
  }
})

const signedIn = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try {
    const session = await requireSession()
    return next({ context: { userId: session.user.id, user: session.user } })
  } catch (error) {
    rethrow(error)
  }
})

export const fetchSession = createServerFn({ method: 'GET' }).handler(async () => {
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
})

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
      return await listPageTree(context.userId, data.spaceId)
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
  .validator((data: { spaceId: string; parentId?: string | null; title?: string }) => data)
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
