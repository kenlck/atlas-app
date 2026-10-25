import { useState } from 'react'
import { relativeTime } from '#/lib/relative-time'

export type TokenRow = {
  id: string
  name: string
  prefix: string
  scope: 'read' | 'read_write'
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

type Created = TokenRow & { token: string }

function scopeLabel(scope: TokenRow['scope']) {
  return scope === 'read_write' ? 'Read and write' : 'Read'
}

function expiryLabel(value: string | null) {
  if (!value) return 'No expiry'
  return `Expires ${value.slice(0, 10)}`
}

export function Tokens({ tokens }: { tokens: TokenRow[] }) {
  const [rows, setRows] = useState(tokens)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<TokenRow['scope']>('read')
  const [expiresIn, setExpiresIn] = useState('90d')
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
        body: JSON.stringify({ name: trimmed, scope, expiresIn }),
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
        <label htmlFor="token-scope">Access</label>
        <select
          id="token-scope"
          className="in"
          value={scope}
          onChange={(event) =>
            setScope(event.target.value as TokenRow['scope'])
          }
        >
          <option value="read">Read</option>
          <option value="read_write">Read and write</option>
        </select>
        <label htmlFor="token-expiry">Expires</label>
        <select
          id="token-expiry"
          className="in"
          value={expiresIn}
          onChange={(event) => setExpiresIn(event.target.value)}
        >
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="365d">1 year</option>
          <option value="never">Never</option>
        </select>
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
              {token.prefix}… · {scopeLabel(token.scope)} ·{' '}
              {expiryLabel(token.expiresAt)} ·{' '}
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
