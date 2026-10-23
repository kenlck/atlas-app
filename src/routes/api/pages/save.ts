import { createFileRoute } from '@tanstack/react-router'
import { HttpError } from '#/lib/http'
import { savePage } from '#/lib/pages'
import { requireUnlockedSession } from '#/lib/session'
import type { Json } from '#/lib/body-text'

export const Route = createFileRoute('/api/pages/save')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await requireUnlockedSession()
          const payload = (await request.json()) as {
            pageId?: unknown
            title?: unknown
            body?: unknown
          }
          if (typeof payload.pageId !== 'string' || typeof payload.title !== 'string') {
            return new Response(JSON.stringify({ error: 'Bad request' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          await savePage(session.user.id, {
            pageId: payload.pageId,
            title: payload.title,
            body: payload.body as Json,
          })
          return new Response(null, { status: 204 })
        } catch (error) {
          if (error instanceof HttpError) {
            return new Response(JSON.stringify({ error: error.message }), {
              status: error.status,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    },
  },
})
