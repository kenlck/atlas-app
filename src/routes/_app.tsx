import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { fetchSession } from '#/server/fns'

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const session = await fetchSession()
    if (!session) {
      throw redirect({ to: '/sign-in' })
    }
    if (session.user.mustChangePassword) {
      throw redirect({ to: '/set-password' })
    }
    return { session }
  },
  component: () => <Outlet />,
})
