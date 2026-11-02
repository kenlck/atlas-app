import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/healthcheck')({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { ok: true },
          { headers: { 'cache-control': 'no-store' } },
        ),
    },
  },
})
