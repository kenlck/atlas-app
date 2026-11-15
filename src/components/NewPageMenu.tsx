import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

export function NewPageMenu({
  label,
  className,
  style,
  rail,
  onChoose,
}: {
  label: string
  className?: string
  style?: CSSProperties
  rail?: boolean
  onChoose: (kind: 'doc' | 'whiteboard') => void
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  return (
    <div className="new-page" onClick={(event) => event.stopPropagation()}>
      <button
        className={className}
        style={style}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={rail ? label : undefined}
        title={rail ? label : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {rail ? <span aria-hidden="true">+</span> : label}
      </button>
      {open ? (
        <div className="menu" role="menu">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onChoose('doc')
            }}
          >
            Page
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onChoose('whiteboard')
            }}
          >
            Whiteboard
          </button>
        </div>
      ) : null}
    </div>
  )
}
