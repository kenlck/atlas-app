import {
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { CalendarView } from '#/components/CalendarView'
import { fetchCalendar } from '#/server/fns'

function loaderError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Unauthorized') throw redirect({ to: '/sign-in' })
  if (message === 'Password change required')
    throw redirect({ to: '/set-password' })
  if (message === 'Not found') throw notFound()
  throw error
}

export const Route = createFileRoute('/_app/s/$spaceId/calendar')({
  loader: async ({ params }) => {
    try {
      return await fetchCalendar({ data: { spaceId: params.spaceId } })
    } catch (error) {
      loaderError(error)
    }
  },
  staleTime: 0,
  preload: false,
  pendingMs: 0,
  pendingMinMs: 0,
  component: CalendarRoute,
  pendingComponent: CalendarPending,
  errorComponent: CalendarError,
  notFoundComponent: () => (
    <div className="nf">
      <h1>Page not found.</h1>
    </div>
  ),
})

function CalendarRoute() {
  const data = Route.useLoaderData()
  return <CalendarView teamId={data.teamId} />
}

function CalendarPending() {
  return (
    <>
      <div className="top">
        <b>Calendar</b>
      </div>
      <div className="doc">
        <div className="col">
          <div className="skel" />
          <div className="skel" />
          <div className="skel" />
        </div>
      </div>
    </>
  )
}

function CalendarError() {
  const router = useRouter()
  return (
    <>
      <div className="top">
        <b>Calendar</b>
      </div>
      <div className="doc">
        <div className="col">
          <div className="banner">Couldn't load the calendar.</div>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void router.invalidate()}
          >
            Retry
          </button>
        </div>
      </div>
    </>
  )
}
