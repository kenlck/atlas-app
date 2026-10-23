import { createFileRoute, getRouteApi, notFound, redirect, useParams, useRouter } from '@tanstack/react-router'
import { PageEditor } from '#/components/PageEditor'
import type { TreeNode } from '#/lib/pages'
import { fetchPage } from '#/server/fns'

const spaceRoute = getRouteApi('/_app/s/$spaceId')

function findTitle(nodes: TreeNode[], id: string): string | null {
  for (const node of nodes) {
    if (node.id === id) return node.title
    const nested = findTitle(node.children, id)
    if (nested) return nested
  }
  return null
}

function loaderError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Unauthorized') throw redirect({ to: '/sign-in' })
  if (message === 'Password change required') throw redirect({ to: '/set-password' })
  if (message === 'Not found') throw notFound()
  throw error
}

export const Route = createFileRoute('/_app/s/$spaceId/p/$pageId')({
  loader: async ({ params }) => {
    try {
      return await fetchPage({ data: { pageId: params.pageId } })
    } catch (error) {
      loaderError(error)
    }
  },
  staleTime: 0,
  preload: false,
  pendingMs: 0,
  pendingMinMs: 0,
  component: PageRoute,
  pendingComponent: () => (
    <>
      <div className="top">
        <span className="skel" style={{ width: 180 }} />
      </div>
      <div className="tool">
        <div className="skel" style={{ width: 110 }} />
      </div>
      <div className="doc">
        <div className="col">
          <div className="skel" style={{ height: 34, marginBottom: 6 }} />
          <div className="skel" style={{ height: 16, width: 220, marginBottom: 26 }} />
          <div className="skel" style={{ height: 16 }} />
        </div>
      </div>
    </>
  ),
  errorComponent: PageError,
  notFoundComponent: () => (
    <div className="nf">
      <h1>Page not found.</h1>
    </div>
  ),
})

function PageError() {
  const router = useRouter()
  const params = useParams({ from: '/_app/s/$spaceId/p/$pageId' })
  const data = spaceRoute.useLoaderData()
  const title = findTitle(data.tree, params.pageId) ?? 'Page'
  return (
    <>
      <div className="top">
        <b>{title}</b>
      </div>
      <div className="nf">
        <h1>Couldn't load this page.</h1>
        <p className="empty">Something went wrong.</p>
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            void router.invalidate()
          }}
        >
          Try again
        </button>
      </div>
    </>
  )
}

function PageRoute() {
  const page = Route.useLoaderData()
  return <PageEditor page={page} />
}
