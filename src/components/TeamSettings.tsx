import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { NO_ACCOUNT } from '#/lib/invite-copy'
import { initials } from '#/lib/relative-time'
import {
  createInviteFn,
  deleteTeamFn,
  lookupAccountFn,
  removeMemberFn,
} from '#/server/fns'

type Member = {
  id: string
  name: string
  email: string
  role: 'owner' | 'member'
}

type PendingInvite = {
  id: string
  inviteeUserId: string
  name: string
  email: string
}

type Found = { id: string; name: string; email: string }

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return ''
}

export function TeamSettings({
  teamId,
  name,
  role,
  members,
  invites,
}: {
  teamId: string
  name: string
  role: 'owner' | 'member'
  members: Member[]
  invites: PendingInvite[]
}) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<
    'idle' | 'loading' | 'found' | 'missing' | 'error'
  >('idle')
  const [found, setFound] = useState<Found | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const refresh = () => {
    void router.invalidate()
  }

  const lookup = async () => {
    setPhase('loading')
    setFound(null)
    setLookupError(null)
    try {
      const result = await lookupAccountFn({
        data: { teamId, email, screen: 'lookup' },
      })
      setFound(result)
      setPhase('found')
    } catch (error) {
      const message = messageOf(error)
      if (message.includes(NO_ACCOUNT)) {
        setPhase('missing')
        return
      }
      setLookupError(message || 'Could not look up that email.')
      setPhase('error')
    }
  }

  const send = async () => {
    if (!found) return
    await createInviteFn({ data: { teamId, userId: found.id } })
    setEmail('')
    setFound(null)
    setPhase('idle')
    refresh()
  }

  return (
    <>
      <div className="top">
        <b>Members</b>
      </div>
      <div className="doc">
        <div className="col" data-role={role}>
          <h1>{name}</h1>
          <p className="empty">
            People in this team can open its pages and mention each other.
          </p>
          {members.map((member) => (
            <div className="member-row" key={member.id}>
              <div className="av">{initials(member.name)}</div>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{member.name}</div>
                <div className="subline">{member.email}</div>
              </div>
              <span className="role-pill">{member.role}</span>
              {role === 'owner' && member.role !== 'owner' ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    void removeMemberFn({
                      data: { teamId, userId: member.id },
                    }).then(() => refresh())
                  }
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          {role === 'owner' ? (
            <>
              <h2 className="section">Invite</h2>
              <label htmlFor="invite-email">Email</label>
              <div className="invite-row">
                <input
                  id="invite-email"
                  className="in"
                  value={email}
                  placeholder="name@example.com"
                  onChange={(event) => {
                    setEmail(event.target.value)
                    if (phase !== 'idle' && phase !== 'loading')
                      setPhase('idle')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void lookup()
                  }}
                />
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => void lookup()}
                >
                  Look up
                </button>
              </div>
              {phase === 'loading' ? <div className="skel" /> : null}
              {phase === 'missing' ? (
                <p className="err">No account with that email.</p>
              ) : null}
              {phase === 'error' && lookupError ? (
                <div className="banner">
                  {lookupError}
                  <button type="button" onClick={() => void lookup()}>
                    Retry
                  </button>
                </div>
              ) : null}
              {phase === 'found' && found ? (
                <div className="found">
                  <div className="av">{initials(found.name)}</div>
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{found.name}</div>
                    <div className="subline">{found.email}</div>
                  </div>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void send()}
                  >
                    Send invite
                  </button>
                </div>
              ) : null}
              <h2 className="section">Pending invites</h2>
              {invites.length === 0 ? (
                <p className="empty">No pending invites.</p>
              ) : null}
              {invites.map((invite) => (
                <div className="member-row" key={invite.id}>
                  <div className="av">{initials(invite.name)}</div>
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{invite.name}</div>
                    <div className="subline">{invite.email}</div>
                  </div>
                  <span className="role-pill">Invited</span>
                </div>
              ))}
              {confirmDelete ? (
                <div className="banner" style={{ marginTop: 24 }}>
                  Delete this team and its pages?
                  <button
                    type="button"
                    onClick={() =>
                      void deleteTeamFn({ data: { teamId } }).then(() => {
                        window.location.assign('/')
                      })
                    }
                  >
                    Delete team
                  </button>
                </div>
              ) : (
                <button
                  className="btn danger"
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete team
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}
