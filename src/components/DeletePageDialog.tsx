import { useEffect, useRef, useState } from 'react'

export function DeletePageDialog({
  title,
  childCount,
  onCancel,
  onConfirm,
}: {
  title: string
  childCount: number
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    node.addEventListener('keydown', onKey)
    return () => node.removeEventListener('keydown', onKey)
  }, [onCancel])

  const confirm = () => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setFailed(false)
    void onConfirm()
      .then(() => undefined)
      .catch(() => {
        busy.current = false
        setPending(false)
        setFailed(true)
      })
  }

  return (
    <div className="delete-modal">
      <div className="scrim" onClick={onCancel} />
      <div
        ref={dialogRef}
        className="card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-page-title"
      >
        <h1 id="delete-page-title">Delete “{title}”?</h1>
        <p className="delete-copy">
          Its {childCount} sub-pages and their whiteboards will be deleted too.
        </p>
        <p className="delete-copy">This can't be undone.</p>
        {failed ? (
          <p className="banner" role="alert">
            Couldn't delete this page.
          </p>
        ) : null}
        <div className="delete-actions">
          <button
            ref={cancelRef}
            className="btn secondary"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={pending}
            onClick={confirm}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
              }
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
