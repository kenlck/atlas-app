import { useState } from 'react'
import { relativeTime } from '#/lib/relative-time'

export type TokenRow = {
  id: string
  name: string
  prefix: string
  lastUsedAt: string | null
  createdAt: string
}

type Created = TokenRow & { token: string }

export function Tokens({ tokens }: { tokens: TokenRow[] }) {
  const [rows, setRows] = useState(tokens)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<Created | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter a name.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const response = await fetch('/api/atlas/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!response.ok) {
        setError("Couldn't create the token.")
        setPending(false)
        return
      }
      const created = (await response.json()) as Created
      setFresh(created)
      setRows((current) => [
        created,
        ...current.filter((row) => row.id !== created.id),
      ])
      setName('')
      setPending(false)
    } catch {
      setError("Couldn't create the token.")
      setPending(false)
    }
  }

  const revoke = async (id: string) => {
    setError(null)
    const response = await fetch(`/api/atlas/tokens/${id}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      setError("Couldn't revoke the token.")
      return
    }
    setRows((current) => current.filter((row) => row.id !== id))
    setFresh((current) => (current?.id === id ? null : current))
  }

  return (
    <section className="token-section">
      <h2 className="section">Tokens</h2>
      <p className="empty">
        A token works as you. It can only reach pages you can already open.
      </p>
      <div className="token-form">
        <label htmlFor="token-name">Name</label>
        <input
          id="token-name"
          className="in"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="btn"
          type="button"
          disabled={pending}
          onClick={() => void create()}
        >
          Create token
        </button>
      </div>
      {error ? <div className="banner">{error}</div> : null}
      {fresh ? (
        <div className="token-reveal banner">
          <p>Copy this token now. It won't be shown again.</p>
          <input
            className="in token-once"
            readOnly
            value={fresh.token}
            aria-label="New token"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      {rows.length === 0 ? <p className="empty">No tokens.</p> : null}
      {rows.map((token) => (
        <div className="invite-card" key={token.id}>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{token.name}</div>
            <div className="subline">
              {token.prefix}… ·{' '}
              {token.lastUsedAt
                ? `Used ${relativeTime(token.lastUsedAt)}`
                : 'Not used yet'}
            </div>
          </div>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void revoke(token.id)}
          >
            Revoke
          </button>
        </div>
      ))}
    </section>
  )
}
