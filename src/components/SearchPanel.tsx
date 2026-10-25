import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SearchHit } from '#/lib/search'
import { searchPagesFn } from '#/server/fns'

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function editedLabel(iso: string, now = new Date()) {
  const then = new Date(iso)
  const elapsed = now.getTime() - then.getTime()
  const day = 86_400_000
  if (elapsed >= 0 && elapsed < 7 * day) {
    const days = Math.floor(elapsed / day)
    if (days >= 1) return `${days}d`
    const hours = Math.floor(elapsed / 3_600_000)
    if (hours >= 1) return `${hours}h`
    const minutes = Math.floor(elapsed / 60_000)
    if (minutes >= 1) return `${minutes}m`
    return 'now'
  }
  const month = MONTHS[then.getMonth()] ?? ''
  const date = then.getDate()
  if (then.getFullYear() !== now.getFullYear()) {
    return `${month} ${date}, ${then.getFullYear()}`
  }
  return `${month} ${date}`
}

function quotedTerm(query: string) {
  const trimmed = query.trim()
  const cut = trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
  return `‘${cut}’`
}

function highlight(text: string, query: string) {
  const needle = query.trim()
  if (!needle) return text
  const lower = text.toLowerCase()
  const find = needle.toLowerCase()
  const parts: Array<string | { mark: string }> = []
  let cursor = 0
  let at = lower.indexOf(find, cursor)
  while (at !== -1) {
    if (at > cursor) parts.push(text.slice(cursor, at))
    parts.push({ mark: text.slice(at, at + needle.length) })
    cursor = at + needle.length
    at = lower.indexOf(find, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.map((part, index) =>
    typeof part === 'string' ? (
      <span key={index}>{part}</span>
    ) : (
      <mark key={index} className="search-mark">
        {part.mark}
      </mark>
    ),
  )
}

function Magnifier() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="4.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10.5 10.5 L13.5 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function SearchPanel({
  onClose,
  onOpen,
}: {
  onClose: () => void
  onOpen: (hit: SearchHit, newTab: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  )
  const [attempt, setAttempt] = useState(0)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const ticketRef = useRef(0)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    inputRef.current?.focus()
    return () => {
      restoreRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      ticketRef.current += 1
      setHits([])
      setPhase('idle')
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      const ticket = ++ticketRef.current
      setPhase('loading')
      searchPagesFn({ data: { query } })
        .then((result) => {
          if (cancelled || ticket !== ticketRef.current) return
          setHits(result.hits)
          setPhase('ready')
        })
        .catch(() => {
          if (cancelled || ticket !== ticketRef.current) return
          setPhase('error')
        })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, attempt])

  const shown = hits.slice(0, 20)
  const capped = hits.length > 20

  useEffect(() => {
    setActive(0)
  }, [hits])

  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, shown.length])

  const openHit = (hit: SearchHit, newTab: boolean) => {
    onOpen(hit, newTab)
    if (!newTab) onClose()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (shown.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(index + 1, shown.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      const hit = shown[active]
      if (!hit) return
      event.preventDefault()
      openHit(hit, event.metaKey || event.ctrlKey)
    }
  }

  let cursor = 0
  const renderHit = (hit: SearchHit) => {
    const index = cursor
    cursor += 1
    const content = hit.group === 'content'
    return (
      <button
        key={hit.id}
        type="button"
        role="option"
        aria-selected={index === active}
        ref={(node) => {
          rowRefs.current[index] = node
        }}
        className={
          index === active
            ? `search-hit ${content ? 'content' : 'title'} act`
            : `search-hit ${content ? 'content' : 'title'}`
        }
        onMouseEnter={() => setActive(index)}
        onClick={(event) => openHit(hit, event.metaKey || event.ctrlKey)}
      >
        <span className="search-title">{highlight(hit.title, query)}</span>
        <span className="search-meta">
          <span className="mono">{editedLabel(hit.updatedAt)}</span>
          <span className="search-space">{hit.spaceName}</span>
        </span>
        {content ? (
          <span className="search-snippet">
            {highlight(hit.snippet, query)}
          </span>
        ) : null}
      </button>
    )
  }

  const titles = shown.filter((hit) => hit.group === 'title')
  const content = shown.filter((hit) => hit.group === 'content')
  const trimmed = query.trim()
  const showIdle = trimmed.length === 0
  const showSkel = !showIdle && phase === 'loading' && shown.length === 0
  const showEmpty = !showIdle && phase === 'ready' && shown.length === 0

  return (
    <div className="search-modal">
      <div className="scrim" onClick={onClose} />
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search pages"
        onKeyDown={onKeyDown}
      >
        <div className="search-field">
          <Magnifier />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search pages"
            aria-label="Search pages"
            onChange={(event) => setQuery(event.target.value)}
          />
          {phase === 'loading' ? <span className="search-bar" /> : null}
        </div>
        <div
          className="search-results"
          role="listbox"
          aria-label="Search results"
        >
          {phase === 'error' ? (
            <div className="banner">
              Couldn't search right now.
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : null}
          {showIdle ? (
            <div className="empty search-idle">
              Search titles and page text across your spaces.
            </div>
          ) : null}
          {showSkel ? (
            <>
              <div className="skel" />
              <div className="skel" />
              <div className="skel" />
            </>
          ) : null}
          {showEmpty ? (
            <div className="search-none">
              No pages match {quotedTerm(query)}
            </div>
          ) : null}
          {titles.length > 0 ? <div className="lab">Titles</div> : null}
          {titles.map(renderHit)}
          {content.length > 0 ? <div className="lab">Content</div> : null}
          {content.map(renderHit)}
          {capped ? (
            <div className="search-cap">
              Showing top 20. Refine your search.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function SearchGlyph() {
  return <Magnifier />
}
