import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { PageEditor } from '#/components/PageEditor'
import { fetchPage } from '#/server/fns'

export const Route = createFileRoute('/_app/s/$spaceId/p/$pageId')({
  loader: async ({ params }) => {
    try {
      return await fetchPage({ data: { pageId: params.pageId } })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'Unauthorized') throw redirect({ to: '/sign-in' })
      if (message === 'Password change required') throw redirect({ to: '/set-password' })
      throw notFound()
    }
  },
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
  errorComponent: () => (
    <div className="nf">
      <h1>Page not found.</h1>
    </div>
  ),
  notFoundComponent: () => (
    <div className="nf">
      <h1>Page not found.</h1>
    </div>
  ),
})

function PageRoute() {
  const page = Route.useLoaderData()
  return <PageEditor page={page} />
}
