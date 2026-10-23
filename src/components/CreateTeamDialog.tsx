import { useEffect, useState } from 'react'
import { createTeamFn } from '#/server/fns'

function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return 'Could not create the team.'
}

export function CreateTeamDialog({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (spaceId: string) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter a team name.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const created = await createTeamFn({ data: { name: trimmed } })
      onCreated(created.spaceId)
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  return (
    <div className="team-modal">
      <div className="scrim" onClick={onCancel} />
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-team-title"
      >
        <h1 id="create-team-title">Create team</h1>
        <div className="sub">The team gets its own space.</div>
        <label htmlFor="team-name">Team name</label>
        <input
          id="team-name"
          className={error ? 'in bad' : 'in'}
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
        {error ? <div className="err">{error}</div> : null}
        <button
          className="btn"
          type="button"
          disabled={pending}
          onClick={() => void submit()}
        >
          Create team
        </button>
        <div className="foot-auth">
          <button className="ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
