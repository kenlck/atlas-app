import {
  createFileRoute,
  getRouteApi,
  notFound,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AppFrame } from '#/components/AppFrame'
import { Sidebar } from '#/components/Sidebar'
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
  errorComponent: SpaceError,
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

function SpaceError() {
  const router = useRouter()
  const { spaceId } = Route.useParams()
  const { session } = appRoute.useRouteContext()
  const name = session.user.name
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    if (!drawer) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  return (
    <div className="app">
      {drawer ? (
        <div className="scrim" onClick={() => setDrawer(false)} />
      ) : null}
      <Sidebar
        spaceId={spaceId}
        spaceName={name}
        userName={name}
        tree={[]}
        spaces={[{ id: spaceId, name, kind: 'personal', role: 'personal' }]}
        role="personal"
        pendingInvites={0}
        open={drawer}
        onCreate={() => undefined}
        onRename={() => undefined}
        onMove={() => undefined}
        onArchive={() => undefined}
        onCreateTeam={() => undefined}
        onNavigate={() => setDrawer(false)}
      />
      <div className="main" style={{ position: 'relative' }}>
        <button
          className="menu-btn"
          type="button"
          aria-label="Open pages"
          onClick={() => setDrawer(true)}
        >
          ☰
        </button>
        <div className="top">
          <b>Pages</b>
        </div>
        <div className="nf">
          <h2>Couldn't load this space.</h2>
          <p className="empty">Something went wrong.</p>
          <button
            type="button"
            className="btn secondary"
            onClick={() => void router.invalidate()}
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}

function SpacePending() {
  return (
    <div className="app">
      <aside className="side">
        <div className="switcher-wrap">
          <div className="sw">
            <div className="av">A</div>
            Atlas
          </div>
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
