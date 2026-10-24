import { createFileRoute } from '@tanstack/react-router'
import { getRequestIP } from '@tanstack/react-start/server'
import { handleAuthRequest } from '#/lib/auth-guard'

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request, getRequestIP()),
      POST: ({ request }) => handleAuthRequest(request, getRequestIP()),
    },
  },
})
