import { createFileRoute } from '@tanstack/react-router'
import { handleMcp } from '#/lib/mcp'

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: ({ request }) => handleMcp(request),
    },
  },
})
