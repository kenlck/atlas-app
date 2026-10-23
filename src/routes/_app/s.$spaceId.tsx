import { createFileRoute, getRouteApi, notFound, redirect } from '@tanstack/react-router'
import { AppFrame } from '#/components/AppFrame'
import { fetchPageTree } from '#/server/fns'

const appRoute = getRouteApi('/_app')

export const Route = createFileRoute('/_app/s/$spaceId')({
  loader: async ({ params }) => {
    try {
      return await fetchPageTree({ data: { spaceId: params.spaceId } })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'Unauthorized') throw redirect({ to: '/sign-in' })
      if (message === 'Password change required') throw redirect({ to: '/set-password' })
      throw notFound()
    }
  },
  component: SpaceLayout,
  pendingComponent: SpacePending,
  notFoundComponent: () => (
    <div className="nf">
      <h1>Page not found.</h1>
    </div>
  ),
})

function SpaceLayout() {
  const data = Route.useLoaderData()
  const { session } = appRoute.useRouteContext()
  return (
    <AppFrame
      spaceId={data.space.id}
      spaceName={data.space.name}
      userName={session.user.name}
      tree={data.tree}
    />
  )
}

function SpacePending() {
  const { session } = appRoute.useRouteContext()
  const { spaceId } = Route.useParams()
  return (
    <AppFrame
      spaceId={spaceId}
      spaceName={session.user.name}
      userName={session.user.name}
      tree={[]}
      loading
    />
  )
}
