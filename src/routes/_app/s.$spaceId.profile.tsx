import {
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { Invitations } from '#/components/Invitations'
import { fetchInvitations } from '#/server/fns'

function loaderError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Unauthorized') throw redirect({ to: '/sign-in' })
  if (message === 'Password change required')
    throw redirect({ to: '/set-password' })
  if (message === 'Not found') throw notFound()
  throw error
}

export const Route = createFileRoute('/_app/s/$spaceId/profile')({
  loader: async () => {
    try {
      return await fetchInvitations({ data: { screen: 'invitations' } })
    } catch (error) {
      loaderError(error)
    }
  },
  staleTime: 0,
  preload: false,
  pendingMs: 0,
  pendingMinMs: 0,
  component: ProfileRoute,
  pendingComponent: InvitationsPending,
  errorComponent: InvitationsError,
  notFoundComponent: () => (
    <div className="nf">
      <h1>Page not found.</h1>
    </div>
  ),
})

function ProfileRoute() {
  const data = Route.useLoaderData()
  return <Invitations invites={data.invites} />
}

function InvitationsPending() {
  return (
    <>
      <div className="top">
        <b>Invitations</b>
      </div>
      <div className="doc">
        <div className="col">
          <div className="skel" />
          <div className="skel" />
        </div>
      </div>
    </>
  )
}

function InvitationsError() {
  const router = useRouter()
  return (
    <>
      <div className="top">
        <b>Invitations</b>
      </div>
      <div className="doc">
        <div className="col">
          <div className="banner">Couldn't load invitations.</div>
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
