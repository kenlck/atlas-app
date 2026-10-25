import { createFileRoute } from '@tanstack/react-router'
import { handleMcp } from '#/lib/mcp'

function methodNotAllowed() {
  return new Response(null, { status: 405, headers: { allow: 'POST' } })
}

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: ({ request }) => handleMcp(request),
      GET: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
})
