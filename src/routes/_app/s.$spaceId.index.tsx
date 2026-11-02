import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { useSpaceOutlet } from '#/components/AppFrame'

const spaceRoute = getRouteApi('/_app/s/$spaceId')

export const Route = createFileRoute('/_app/s/$spaceId/')({
  component: EmptySpace,
})

function EmptySpace() {
  const { tree } = spaceRoute.useLoaderData()
  const { createRoot } = useSpaceOutlet()
  const [adding, setAdding] = useState(false)

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
              <div className="new-page">
                <button
                  className="btn"
                  style={{ width: 'auto', padding: '0 12px' }}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={adding}
                  onClick={() => setAdding((open) => !open)}
                >
                  + New page
                </button>
                {adding ? (
                  <div className="menu" role="menu">
                    <button type="button" onClick={() => createRoot('doc')}>
                      Page
                    </button>
                    <button type="button" onClick={() => createRoot('whiteboard')}>
                      Whiteboard
                    </button>
                  </div>
                ) : null}
              </div>
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
