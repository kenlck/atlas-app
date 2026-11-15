import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export function PageMenu({
  canDelete,
  canLock,
  locked,
  onDelete,
  onLock,
  saveLabel = '',
  onCreate,
}: {
  canDelete: boolean
  canLock: boolean
  locked: boolean
  onDelete: () => void
  onLock: () => void
  saveLabel?: string
  onCreate?: (kind: 'doc' | 'whiteboard') => void
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    el.style.left = ''
    el.style.right = ''
    el.style.maxWidth = ''
    if (!open || window.innerWidth >= 640) return
    el.style.left = 'auto'
    el.style.right = '0px'
    const box = el.getBoundingClientRect()
    const limit = window.innerWidth - 8
    if (box.right > limit) el.style.right = `${box.right - limit}px`
    const next = el.getBoundingClientRect()
    if (next.left < 8) {
      el.style.left = '8px'
      el.style.right = 'auto'
      el.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`
    }
  }, [open, saveLabel, creating])

  const choose = (kind: 'doc' | 'whiteboard') => {
    setOpen(false)
    setCreating(false)
    onCreate?.(kind)
  }

  return (
    <div className="new-page page-menu" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="ghost page-menu-btn"
        aria-label="Page menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setCreating(false)
          setOpen((value) => !value)
        }}
      >
        ⋯
      </button>
      {open ? (
        <div className="menu" role="menu" ref={menuRef}>
          {onCreate ? (
            <div className="phone-menu-only">
              <button type="button" aria-expanded={creating} onClick={() => setCreating((value) => !value)}>
                Create page
              </button>
              {creating ? (
                <>
                  <button type="button" onClick={() => choose('doc')}>
                    Page
                  </button>
                  <button type="button" onClick={() => choose('whiteboard')}>
                    Whiteboard
                  </button>
                </>
              ) : null}
              {saveLabel ? <div className="menu-status">{saveLabel}</div> : null}
              {canLock || canDelete ? <div className="menu-sep" role="separator" /> : null}
            </div>
          ) : null}
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
          {canDelete ? (
            <>
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
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
