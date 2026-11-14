import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TreeNode } from '#/lib/pages'
import { NewPageMenu } from './NewPageMenu'

function depthPad(depth: number) {
  return { paddingLeft: `${8 + 18 * depth}px` }
}

function LockIcon() {
  return (
    <svg className="lock" viewBox="0 0 16 16" role="img" aria-label="Locked">
      <rect x="3.5" y="7" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function PenIcon() {
  return (
    <svg className="pen" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M11.2 1.8l3 3L5.6 13.4 2.2 14l.6-3.4L11.2 1.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

function collectIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...collectIds(node.children)])
}

function ancestorIds(nodes: TreeNode[], pageId: string): string[] | null {
  for (const node of nodes) {
    if (node.id === pageId) return []
    const nested = ancestorIds(node.children, pageId)
    if (nested !== null) return [node.id, ...nested]
  }
  return null
}

export function PageTree({
  spaceId,
  tree,
  activeId,
  onCreate,
  onRename,
  onMove,
  onArchive,
  onLock,
}: {
  spaceId: string
  tree: TreeNode[]
  activeId?: string
  onCreate: (parentId: string | null, kind?: 'doc' | 'whiteboard') => void
  onRename: (pageId: string, title: string) => void
  onMove: (pageId: string) => void
  onArchive: (pageId: string) => void
  onLock: (pageId: string, locked: boolean) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(collectIds(tree).map((id) => [id, true])),
  )
  const [menu, setMenu] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const expandedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!activeId || expandedFor.current === activeId) return
    const ancestors = ancestorIds(tree, activeId)
    if (!ancestors) return
    expandedFor.current = activeId
    setOpen((current) => {
      let changed = false
      const next = { ...current }
      for (const id of ancestors) {
        if (next[id] === false) {
          next[id] = true
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [activeId, tree])

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const expanded = open[node.id] !== false
      const hasKids = node.children.length > 0
      return (
        <div key={node.id}>
          <div style={{ position: 'relative' }}>
            {editing === node.id ? (
              <input
                className="it"
                aria-label="Page title"
                style={depthPad(depth)}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                  onRename(node.id, draft)
                  setEditing(null)
                }}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Enter') {
                    onRename(node.id, draft)
                    setEditing(null)
                  }
                  if (event.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <Link
                to="/s/$spaceId/p/$pageId"
                params={{ spaceId, pageId: node.id }}
                preload={false}
                className={node.id === activeId ? 'it act' : 'it'}
                style={depthPad(depth)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu(node.id)
                }}
              >
                {node.locked ? <LockIcon /> : null}
                {node.kind === 'whiteboard' ? <PenIcon /> : null}
                {hasKids ? (
                  <span
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setOpen((current) => ({
                        ...current,
                        [node.id]: !expanded,
                      }))
                    }}
                  >
                    {expanded ? '▾' : '▸'}
                  </span>
                ) : (
                  <span className="dot" style={{ width: 6, height: 6 }} />
                )}
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {node.title}
                </span>
              </Link>
            )}
            {menu === node.id ? (
              <div className="menu" style={{ right: 8, top: 28 }}>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(node.title)
                    setEditing(node.id)
                    setMenu(null)
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null)
                    onMove(node.id)
                  }}
                >
                  Move
                </button>
                {node.canLock ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null)
                      onLock(node.id, !node.locked)
                    }}
                  >
                    {node.locked ? 'Unlock' : 'Lock'}
                  </button>
                ) : null}
                {node.canDelete ? (
                  <>
                    <div className="menu-sep" role="separator" />
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setMenu(null)
                        onArchive(node.id)
                      }}
                    >
                      Delete page
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className="row-more"
              aria-label="Page menu"
              aria-expanded={menu === node.id}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setMenu((current) => (current === node.id ? null : node.id))
              }}
            >
              ⋯
            </button>
          </div>
          {hasKids && expanded ? render(node.children, depth + 1) : null}
        </div>
      )
    })

  return (
    <div
      className="tree"
      onClick={() => {
        setMenu(null)
      }}
    >
      {tree.length === 0 ? (
        <div className="it" style={{ color: 'var(--muted)' }}>
          No pages
        </div>
      ) : (
        render(tree, 0)
      )}
      <NewPageMenu
        label="+ New page"
        className="it"
        style={{ color: 'var(--muted)' }}
        onChoose={(kind) => onCreate(null, kind)}
      />
    </div>
  )
}
