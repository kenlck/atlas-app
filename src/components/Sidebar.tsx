import { Link, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { authClient } from '#/lib/auth-client'
import type { SpaceRole } from '#/lib/access'
import { initials } from '#/lib/relative-time'
import type { TreeNode } from '#/lib/pages'
import type { SpaceSummary } from '#/lib/teams'
import { PageTree } from './PageTree'
import { SearchGlyph } from './SearchPanel'
import { SpaceSwitcher } from './SpaceSwitcher'

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
  onArchive,
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
  onCreate: (parentId: string | null) => void
  onRename: (pageId: string, title: string) => void
  onMove: (pageId: string) => void
  onArchive: (pageId: string) => void
  onCreateTeam: () => void
  onNavigate: () => void
  onOpenSearch: () => void
}) {
  const [shortcut, setShortcut] = useState('Ctrl K')
  useEffect(() => {
    const platform = navigator.platform ?? ''
    const agent = navigator.userAgent ?? ''
    if (/Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(agent)) {
      setShortcut('⌘K')
    }
  }, [])
  const onCalendar = useRouterState({
    select: (state) => state.location.pathname.endsWith('/calendar'),
  })
  return (
    <aside className={open ? 'side open' : 'side'}>
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
        className="it"
        aria-label="Search"
        onClick={onOpenSearch}
      >
        <SearchGlyph />
        Search
        <span className="k">{shortcut}</span>
      </button>
      <div className="lab">Pages</div>
      {role === 'personal' ? null : (
        <Link
          to="/s/$spaceId/calendar"
          params={{ spaceId }}
          className={onCalendar ? 'it act' : 'it'}
          preload={false}
          onClick={onNavigate}
        >
          Calendar
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
          onCreate={onCreate}
          onRename={onRename}
          onMove={onMove}
          onArchive={onArchive}
        />
      )}
      <div className="foot">
        <Link
          to="/s/$spaceId/profile"
          params={{ spaceId }}
          className="me-link"
          aria-label="Profile"
          preload={false}
          onClick={onNavigate}
        >
          <div className="me">{initials(userName)}</div>
          {pendingInvites > 0 ? (
            <span className="pending-dot" aria-label="Pending invitations" />
          ) : null}
        </Link>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{userName}</div>
        </div>
        <button
          type="button"
          className="it"
          style={{ marginLeft: 'auto', width: 'auto' }}
          onClick={() =>
            authClient.signOut({
              fetchOptions: {
                onSuccess: () => window.location.assign('/sign-in'),
              },
            })
          }
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
