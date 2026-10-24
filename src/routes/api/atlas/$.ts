import { createFileRoute } from '@tanstack/react-router'
import { handleAtlasApi } from '#/lib/atlas-api'

export const Route = createFileRoute('/api/atlas/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAtlasApi(request),
      POST: ({ request }) => handleAtlasApi(request),
      DELETE: ({ request }) => handleAtlasApi(request),
    },
  },
})
