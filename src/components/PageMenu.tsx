import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export function PageMenu({
  canDelete,
  canLock,
  locked,
  onDelete,
  onLock,
  notices = null,
}: {
  canDelete: boolean
  canLock: boolean
  locked: boolean
  onDelete: () => void
  onLock: () => void
  notices?: ReactNode
}) {
  void canDelete
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  return (
    <div className="new-page page-menu" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="ghost page-menu-btn"
        aria-label="Page menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open ? (
        <div className="menu" role="menu">
          {notices}
          <button type="button" onClick={() => setOpen(false)}>
            Move
          </button>
          {canLock ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onLock()
              }}
            >
              {locked ? 'Unlock' : 'Lock'}
            </button>
          ) : null}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            className="danger"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete page
          </button>
        </div>
      ) : null}
    </div>
  )
}
