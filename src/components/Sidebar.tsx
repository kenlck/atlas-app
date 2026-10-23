import { Link } from '@tanstack/react-router'
import { authClient } from '#/lib/auth-client'
import { initials } from '#/lib/relative-time'
import type { TreeNode } from '#/lib/pages'
import { PageTree } from './PageTree'

export function Sidebar({
  open,
  spaceId,
  spaceName,
  userName,
  tree,
  activeId,
  loading,
  error,
  onRetry,
  onCreate,
  onRename,
  onMove,
  onArchive,
}: {
  open: boolean
  spaceId: string
  spaceName: string
  userName: string
  tree: TreeNode[]
  activeId?: string
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onCreate: (parentId: string | null) => void
  onRename: (pageId: string, title: string) => void
  onMove: (pageId: string) => void
  onArchive: (pageId: string) => void
}) {
  return (
    <aside className={open ? 'side open' : 'side'}>
      <Link
        to="/s/$spaceId"
        params={{ spaceId }}
        className="sw"
        preload={false}
        aria-label="Personal space"
        style={{ textDecoration: 'none', color: 'inherit' }}
      >
        <div className="av">{initials(spaceName)}</div>
        {spaceName}
      </Link>
      <div className="lab">Pages</div>
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
        <div className="me">{initials(userName)}</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{userName}</div>
        </div>
        <button
          type="button"
          className="it"
          style={{ marginLeft: 'auto', width: 'auto' }}
          onClick={() => authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign('/sign-in') } })}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
