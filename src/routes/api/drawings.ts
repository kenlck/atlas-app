import { createFileRoute } from '@tanstack/react-router'
import { handleDrawingRequest } from '#/lib/drawing-request'

export const Route = createFileRoute('/api/drawings')({
  server: {
    handlers: {
      GET: ({ request }) => handleDrawingRequest(request),
      POST: ({ request }) => handleDrawingRequest(request),
    },
  },
})
