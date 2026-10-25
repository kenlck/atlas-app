import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useSpaceOutlet } from '#/components/AppFrame'

const spaceRoute = getRouteApi('/_app/s/$spaceId')

export const Route = createFileRoute('/_app/s/$spaceId/')({
  component: EmptySpace,
})

function EmptySpace() {
  const { tree } = spaceRoute.useLoaderData()
  const { createRoot } = useSpaceOutlet()

  return (
    <>
      <div className="top">
        <b>Pages</b>
      </div>
      <div className="doc">
        <div className="col">
          {tree.length === 0 ? (
            <>
              <h1>No pages yet</h1>
              <p className="empty">
                Create a page to start writing in this space.
              </p>
              <button
                className="btn"
                style={{ width: 'auto', padding: '0 12px' }}
                type="button"
                onClick={() => createRoot()}
              >
                + New page
              </button>
            </>
          ) : (
            <>
              <h1>Select a page</h1>
              <p className="empty">
                Choose a page from the sidebar, or create a new one.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  )
}
