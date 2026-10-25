import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TreeNode } from '#/lib/pages'

function depthPad(depth: number) {
  return { paddingLeft: `${8 + 18 * depth}px` }
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
}: {
  spaceId: string
  tree: TreeNode[]
  activeId?: string
  onCreate: (parentId: string | null) => void
  onRename: (pageId: string, title: string) => void
  onMove: (pageId: string) => void
  onArchive: (pageId: string) => void
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
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null)
                    onArchive(node.id)
                  }}
                >
                  Archive
                </button>
              </div>
            ) : null}
          </div>
          {hasKids && expanded ? render(node.children, depth + 1) : null}
        </div>
      )
    })

  return (
    <div className="tree" onClick={() => setMenu(null)}>
      {tree.length === 0 ? (
        <div className="it" style={{ color: 'var(--muted)' }}>
          No pages
        </div>
      ) : (
        render(tree, 0)
      )}
      <button
        className="it"
        style={{ color: 'var(--muted)' }}
        type="button"
        onClick={() => onCreate(null)}
      >
        + New page
      </button>
    </div>
  )
}
