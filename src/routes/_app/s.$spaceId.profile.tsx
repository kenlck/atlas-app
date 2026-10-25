import {
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { Invitations } from '#/components/Invitations'
import { Tokens } from '#/components/Tokens'
import { fetchInvitations, fetchTokens } from '#/server/fns'

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
      const [invites, tokens] = await Promise.all([
        fetchInvitations({ data: { screen: 'invitations' } }),
        fetchTokens(),
      ])
      return { invites: invites.invites, tokens: tokens.tokens }
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
  return (
    <Invitations invites={data.invites}>
      <Tokens tokens={data.tokens} />
    </Invitations>
  )
}

function InvitationsPending() {
  return (
    <>
      <div className="top">
        <b>Profile</b>
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
        <b>Profile</b>
      </div>
      <div className="doc">
        <div className="col">
          <div className="banner">Couldn't load profile.</div>
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
