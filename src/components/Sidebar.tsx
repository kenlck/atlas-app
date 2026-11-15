import { Link, useRouterState } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useState } from 'react'
import { authClient } from '#/lib/auth-client'
import type { SpaceRole } from '#/lib/access'
import { initials } from '#/lib/relative-time'
import type { TreeNode } from '#/lib/pages'
import {
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from '#/lib/sidebar-collapse'
import type { SpaceSummary } from '#/lib/teams'
import { PageTree } from './PageTree'
import { SearchGlyph } from './SearchPanel'
import { SpaceSwitcher } from './SpaceSwitcher'

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.75"
        y="2.25"
        width="12.5"
        height="11.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {collapsed ? (
        <path
          d="M6 5.25 8.75 8 6 10.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M6 2.25v11.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      )}
    </svg>
  )
}

function CalendarGlyph() {
  return (
    <svg
      className="rail-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <rect
        x="2.25"
        y="3.25"
        width="11.5"
        height="10.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2.25 6.5h11.5M5 2v3M11 2v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SignOutGlyph() {
  return (
    <svg
      className="rail-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M6.5 2.75H3.75A1.25 1.25 0 0 0 2.5 4v8a1.25 1.25 0 0 0 1.25 1.25H6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M6.75 8h6.25M10.75 5.25 13.5 8l-2.75 2.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Sidebar({
  open,
  spaceId,
  spaceName,
  userName,
  tree,
  activeId,
  loading,
  error,
  spaces,
  role,
  pendingInvites,
  onRetry,
  onCreate,
  onRename,
  onMove,
  onDropMove,
  onArchive,
  onLock,
  onCreateTeam,
  onNavigate,
  onOpenSearch,
}: {
  open: boolean
  spaceId: string
  spaceName: string
  userName: string
  tree: TreeNode[]
  activeId?: string
  loading?: boolean
  error?: string | null
  spaces: SpaceSummary[]
  role: SpaceRole
  pendingInvites: number
  onRetry?: () => void
  onCreate: (parentId: string | null, kind?: 'doc' | 'whiteboard') => void
  onRename: (pageId: string, title: string) => void
  onMove: (pageId: string) => void
  onDropMove: (pageId: string, parentId: string) => void
  onArchive: (pageId: string) => void
  onLock: (pageId: string, locked: boolean) => void
  onCreateTeam: () => void
  onNavigate: () => void
  onOpenSearch: () => void
}) {
  const [shortcut, setShortcut] = useState('Ctrl K')
  const [collapsed, setCollapsed] = useState(false)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const platform = navigator.platform
    const agent = navigator.userAgent
    if (/Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(agent)) {
      setShortcut('⌘K')
    }
  }, [])
  useLayoutEffect(() => {
    setCollapsed(readSidebarCollapsed())
    const query = window.matchMedia('(min-width: 900px)')
    const apply = () => setWide(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])
  const rail = collapsed && wide
  const toggleCollapsed = () => {
    const next = !collapsed
    writeSidebarCollapsed(next)
    setCollapsed(next)
  }
  const onCalendar = useRouterState({
    select: (state) => state.location.pathname.endsWith('/calendar'),
  })
  return (
    <aside className={`side${open ? ' open' : ''}${rail ? ' collapsed' : ''}`}>
      <div className="side-top">
        <SpaceSwitcher
          spaceId={spaceId}
          spaceName={spaceName}
          role={role}
          spaces={spaces}
          onCreateTeam={onCreateTeam}
          onNavigate={onNavigate}
        />
        <button
          type="button"
          className="side-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleCollapsed}
        >
          <SidebarToggleIcon collapsed={collapsed} />
        </button>
      </div>
      <button
        type="button"
        className="it"
        aria-label="Search"
        title={rail ? 'Search' : undefined}
        onClick={onOpenSearch}
      >
        <SearchGlyph />
        <span className="it-label">Search</span>
        <span className="k">{shortcut}</span>
      </button>
      <div className="lab">Pages</div>
      {role === 'personal' ? null : (
        <Link
          to="/s/$spaceId/calendar"
          params={{ spaceId }}
          className={onCalendar ? 'it act' : 'it'}
          aria-label="Calendar"
          title={rail ? 'Calendar' : undefined}
          preload={false}
          onClick={onNavigate}
        >
          <CalendarGlyph />
          <span className="it-label">Calendar</span>
        </Link>
      )}
      {loading ? (
        <div className="tree">
          <div className="skel" />
          <div className="skel" />
          <div className="skel" />
        </div>
      ) : error ? (
        <div className="tree">
          <div className="banner">{error}</div>
          {onRetry ? (
            <button className="it" type="button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : (
        <PageTree
          spaceId={spaceId}
          tree={tree}
          activeId={activeId}
          rail={rail}
          onCreate={onCreate}
          onRename={onRename}
          onMove={onMove}
          onDropMove={onDropMove}
          onArchive={onArchive}
          onLock={onLock}
        />
      )}
      <div className="foot">
        <Link
          to="/s/$spaceId/profile"
          params={{ spaceId }}
          className="me-link"
          aria-label="Profile"
          title={rail ? 'Profile' : undefined}
          preload={false}
          onClick={onNavigate}
        >
          <div className="me">{initials(userName)}</div>
          {pendingInvites > 0 ? (
            <span className="pending-dot" aria-label="Pending invitations" />
          ) : null}
        </Link>
        <div className="foot-copy">
          <div style={{ fontWeight: 600, fontSize: 13 }}>{userName}</div>
        </div>
        <button
          type="button"
          className="it sign-out"
          aria-label="Sign out"
          title={rail ? 'Sign out' : undefined}
          onClick={() =>
            authClient.signOut({
              fetchOptions: {
                onSuccess: () => window.location.assign('/sign-in'),
              },
            })
          }
        >
          <SignOutGlyph />
          <span className="it-label">Sign out</span>
        </button>
      </div>
    </aside>
  )
}
