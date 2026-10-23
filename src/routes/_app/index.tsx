import { createFileRoute, redirect } from '@tanstack/react-router'
import { fetchPersonalSpace } from '#/server/fns'

export const Route = createFileRoute('/_app/')({
  loader: async () => {
    const space = await fetchPersonalSpace()
    throw redirect({ to: '/s/$spaceId', params: { spaceId: space.id } })
  },
})
