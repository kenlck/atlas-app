import {
  Outlet,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { SpaceRole } from '#/lib/access'
import type { TreeNode } from '#/lib/pages'
import type { SpaceSummary } from '#/lib/teams'
import { flushEditor } from '#/lib/editor-flush'
import {
  archivePageFn,
  createPageFn,
  movePageFn,
  renamePageFn,
} from '#/server/fns'
import { CreateTeamDialog } from './CreateTeamDialog'
import { MoveDialog } from './MoveDialog'
import { Sidebar } from './Sidebar'

export function AppFrame({
  spaceId,
  spaceName,
  userName,
  tree,
  loading,
  error,
  spaces,
  role,
  pendingInvites,
  onRetry,
}: {
  spaceId: string
  spaceName: string
  userName: string
  tree: TreeNode[]
  loading?: boolean
  error?: string | null
  spaces: SpaceSummary[]
  role: SpaceRole
  pendingInvites: number
  onRetry?: () => void
}) {
  const [drawer, setDrawer] = useState(false)
  const [moving, setMoving] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const createTeamTrigger = useRef<HTMLElement | null>(null)
  const navigate = useNavigate()
  const router = useRouter()
  const params = useParams({ strict: false }) as { pageId?: string }

  useEffect(() => {
    if (!drawer) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  const refresh = () => {
    void router.invalidate()
  }

  const create = async (parentId: string | null) => {
    await flushEditor()
    const created = await createPageFn({ data: { spaceId, parentId } })
    setDrawer(false)
    await router.invalidate()
    await navigate({
      to: '/s/$spaceId/p/$pageId',
      params: { spaceId, pageId: created.id },
    })
  }

  const rename = async (pageId: string, title: string) => {
    await renamePageFn({ data: { pageId, title } })
    refresh()
  }

  const archive = async (pageId: string) => {
    await archivePageFn({ data: { pageId } })
    if (params.pageId === pageId) {
      await navigate({ to: '/s/$spaceId', params: { spaceId } })
    } else {
      refresh()
    }
  }

  const move = async (parentId: string | null) => {
    if (!moving) return
    await movePageFn({ data: { pageId: moving, parentId } })
    setMoving(null)
    refresh()
  }

  return (
    <div className="app">
      {drawer ? (
        <div className="scrim" onClick={() => setDrawer(false)} />
      ) : null}
      <Sidebar
        open={drawer}
        spaceId={spaceId}
        spaceName={spaceName}
        userName={userName}
        tree={tree}
        activeId={params.pageId}
        loading={loading}
        error={error}
        onRetry={onRetry}
        onCreate={(parentId) => void create(parentId)}
        onRename={(pageId, title) => void rename(pageId, title)}
        onMove={setMoving}
        onArchive={(pageId) => void archive(pageId)}
        spaces={spaces}
        role={role}
        pendingInvites={pendingInvites}
        onCreateTeam={() => {
          const active = document.activeElement
          const trigger =
            active instanceof HTMLElement
              ? (active
                  .closest('.switcher-wrap')
                  ?.querySelector<HTMLElement>('.sw') ?? active)
              : null
          createTeamTrigger.current = trigger
          setDrawer(false)
          setCreating(true)
        }}
        onNavigate={() => setDrawer(false)}
      />
      <div className="main" style={{ position: 'relative' }}>
        <button
          className="menu-btn"
          type="button"
          aria-label="Open pages"
          onClick={() => setDrawer(true)}
        >
          ☰
        </button>
        {error ? (
          <>
            <div className="top">
              <b>Pages</b>
            </div>
            <div className="nf">
              <h1>Couldn't load this space.</h1>
              <p className="empty">Something went wrong.</p>
              {onRetry ? (
                <button type="button" className="btn secondary" onClick={onRetry}>
                  Try again
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <Outlet />
        )}
      </div>
      {moving ? (
        <MoveDialog
          tree={tree}
          pageId={moving}
          onCancel={() => setMoving(null)}
          onMove={(parentId) => void move(parentId)}
        />
      ) : null}
      {creating ? (
        <CreateTeamDialog
          onCancel={() => {
            setCreating(false)
            const trigger = createTeamTrigger.current
            createTeamTrigger.current = null
            trigger?.focus()
          }}
          onCreated={(nextSpaceId) => {
            setCreating(false)
            void router.invalidate().then(() =>
              navigate({
                to: '/s/$spaceId',
                params: { spaceId: nextSpaceId },
              }),
            )
          }}
        />
      ) : null}
    </div>
  )
}
