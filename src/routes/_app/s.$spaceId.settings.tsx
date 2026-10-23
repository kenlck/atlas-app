import {
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { TeamSettings } from '#/components/TeamSettings'
import { fetchTeamSettings } from '#/server/fns'

function loaderError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Unauthorized') throw redirect({ to: '/sign-in' })
  if (message === 'Password change required')
    throw redirect({ to: '/set-password' })
  if (message === 'Not found') throw notFound()
  throw error
}

export const Route = createFileRoute('/_app/s/$spaceId/settings')({
  loader: async ({ params }) => {
    try {
      return await fetchTeamSettings({
        data: { spaceId: params.spaceId, screen: 'members' },
      })
    } catch (error) {
      loaderError(error)
    }
  },
  staleTime: 0,
  preload: false,
  pendingMs: 0,
  pendingMinMs: 0,
  component: SettingsRoute,
  pendingComponent: MembersPending,
  errorComponent: MembersError,
  notFoundComponent: () => (
    <div className="nf">
      <h1>Page not found.</h1>
    </div>
  ),
})

function SettingsRoute() {
  const data = Route.useLoaderData()
  return (
    <TeamSettings
      teamId={data.teamId}
      name={data.name}
      role={data.role}
      members={data.members}
      invites={data.invites}
    />
  )
}

function MembersPending() {
  return (
    <>
      <div className="top">
        <b>Members</b>
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

function MembersError() {
  const router = useRouter()
  return (
    <>
      <div className="top">
        <b>Members</b>
      </div>
      <div className="doc">
        <div className="col">
          <div className="banner">Couldn't load members.</div>
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
