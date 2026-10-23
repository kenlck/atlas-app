import { createFileRoute } from '@tanstack/react-router'
import { getRequestIP } from '@tanstack/react-start/server'
import { handleResetPassword } from '#/lib/admin-reset'

export const Route = createFileRoute('/api/admin/reset-password')({
  server: {
    handlers: {
      POST: ({ request }) => handleResetPassword(request, getRequestIP()),
    },
  },
})
