import { createFileRoute } from '@tanstack/react-router'
import { handlePageSave } from '#/lib/page-save-request'

export const Route = createFileRoute('/api/pages/save')({
  server: {
    handlers: {
      POST: ({ request }) => handlePageSave(request),
    },
  },
})
