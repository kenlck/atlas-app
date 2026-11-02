import { createFileRoute, redirect } from '@tanstack/react-router'
import { fetchDefaultSpace } from '#/server/fns'

export const Route = createFileRoute('/_app/')({
  loader: async () => {
    const space = await fetchDefaultSpace()
    throw redirect({ to: '/s/$spaceId', params: { spaceId: space.id } })
  },
})
