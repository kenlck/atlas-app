import { useEffect, useState } from 'react'

export function PageMenu({
  canDelete,
  onDelete,
}: {
  canDelete: boolean
  onDelete: () => void
}) {
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
