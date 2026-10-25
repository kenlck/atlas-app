import type { ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { initials } from '#/lib/relative-time'
import { acceptInviteFn, declineInviteFn } from '#/server/fns'
import type { InvitationCard } from '#/lib/teams'

export function Invitations({
  invites,
  children,
}: {
  invites: InvitationCard[]
  children?: ReactNode
}) {
  const router = useRouter()
  const refresh = () => {
    void router.invalidate()
  }

  return (
    <>
      <div className="top">
        <b>Profile</b>
      </div>
      <div className="doc">
        <div className="col">
          <h1>Invitations</h1>
          {invites.length === 0 ? (
            <p className="empty">No invitations.</p>
          ) : null}
          {invites.map((invite) => (
            <div className="invite-card" key={invite.id}>
              <div className="av">{initials(invite.teamName)}</div>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{invite.teamName}</div>
                <div className="subline inviter">
                  <span className="me">{initials(invite.invitedByName)}</span>
                  <span>{invite.invitedByName} invited you</span>
                </div>
              </div>
              <div className="actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() =>
                    void acceptInviteFn({ data: { inviteId: invite.id } }).then(
                      () => refresh(),
                    )
                  }
                >
                  Accept
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() =>
                    void declineInviteFn({
                      data: { inviteId: invite.id },
                    }).then(() => refresh())
                  }
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
          {children}
        </div>
      </div>
    </>
  )
}
