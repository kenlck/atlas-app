import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { SpaceRole } from '#/lib/access'
import type { SpaceSummary } from '#/lib/teams'
import { initials } from '#/lib/relative-time'

export function SpaceSwitcher({
  spaceId,
  spaceName,
  role,
  spaces,
  onCreateTeam,
  onNavigate,
}: {
  spaceId: string
  spaceName: string
  role: SpaceRole
  spaces: SpaceSummary[]
  onCreateTeam: () => void
  onNavigate: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node))
        setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="switcher-wrap" ref={root}>
      <button
        type="button"
        className="sw"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${spaceName}, switch space`}
        onClick={() => setOpen((value) => !value)}
      >
        <div className="av">{initials(spaceName)}</div>
        <span className="sw-name">{spaceName}</span>
        <span className="k">▾</span>
      </button>
      {open ? (
        <div className="menu switcher" role="menu">
          {spaces.map((item) => (
            <Link
              key={item.id}
              to="/s/$spaceId"
              params={{ spaceId: item.id }}
              preload={false}
              role="menuitem"
              className={item.id === spaceId ? 'act' : ''}
              onClick={() => {
                setOpen(false)
                onNavigate()
              }}
            >
              <span className="av">{initials(item.name)}</span>
              {item.name}
            </Link>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onCreateTeam()
            }}
          >
            Create team
          </button>
          {role !== 'personal' ? (
            <Link
              to="/s/$spaceId/settings"
              params={{ spaceId }}
              preload={false}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onNavigate()
              }}
            >
              Team settings
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
