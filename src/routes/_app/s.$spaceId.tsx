import {
  createFileRoute,
  getRouteApi,
  notFound,
  redirect,
} from '@tanstack/react-router'
import { AppFrame } from '#/components/AppFrame'
import { fetchPageTree } from '#/server/fns'

const appRoute = getRouteApi('/_app')

function loaderError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Unauthorized') throw redirect({ to: '/sign-in' })
  if (message === 'Password change required')
    throw redirect({ to: '/set-password' })
  if (message === 'Not found') throw notFound()
  throw error
}

export const Route = createFileRoute('/_app/s/$spaceId')({
  loader: async ({ params }) => {
    try {
      return await fetchPageTree({ data: { spaceId: params.spaceId } })
    } catch (error) {
      loaderError(error)
    }
  },
  staleTime: 0,
  preload: false,
  pendingMs: 0,
  pendingMinMs: 0,
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
      spaces={data.spaces}
      role={data.role}
      pendingInvites={data.pendingInvites}
    />
  )
}

function SpacePending() {
  return (
    <div className="app">
      <aside className="side">
        <div className="sw">
          <div className="av">A</div>
          Atlas
        </div>
        <div className="lab">Pages</div>
        <div className="tree">
          <div className="skel" />
          <div className="skel" />
          <div className="skel" />
        </div>
        <div className="foot">
          <div className="me">A</div>
        </div>
      </aside>
      <div className="main">
        <div className="top">
          <span className="skel" style={{ width: 180 }} />
        </div>
      </div>
    </div>
  )
}
