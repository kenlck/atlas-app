import type { ReactNode } from 'react'

function PenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M11.2 1.8l3 3L5.6 13.4 2.2 14l.6-3.4L11.2 1.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="8" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export function PageModeBar({
  breadcrumbs,
  editing,
  saveLabel,
  onEdit,
  onLeave,
  menu,
}: {
  breadcrumbs: Array<{ id: string; title: string }>
  editing: boolean
  saveLabel: string
  onEdit: () => void
  onLeave: () => void
  menu: ReactNode
}) {
  return (
    <div className={editing ? 'top is-editing' : 'top'}>
      <div className="crumbs">
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.id}>
            {index > 0 ? <span> / </span> : null}
            {index === breadcrumbs.length - 1 ? <b>{crumb.title}</b> : crumb.title}
          </span>
        ))}
      </div>
      <div className="r">
        <div className="mode">
          <div className="mode-switch" role="radiogroup" aria-label="Mode">
            <button
              type="button"
              role="radio"
              aria-checked={!editing}
              onClick={() => {
                if (editing) onLeave()
              }}
            >
              View
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={editing}
              onClick={() => {
                if (!editing) onEdit()
              }}
            >
              Edit
            </button>
          </div>
          <button
            type="button"
            className="mode-icon"
            aria-label={editing ? 'View' : 'Edit'}
            aria-pressed={editing}
            onClick={() => {
              if (editing) onLeave()
              else onEdit()
            }}
          >
            {editing ? <EyeIcon /> : <PenIcon />}
          </button>
          {editing ? (
            <span className="editing-chip">
              Editing
              {saveLabel ? <span className="save">{saveLabel}</span> : null}
            </span>
          ) : null}
          {editing ? (
            <button type="button" className="ghost mode-done" onClick={onLeave}>
              Done
            </button>
          ) : null}
        </div>
        {menu}
        {editing ? null : <span className="save">{saveLabel}</span>}
      </div>
    </div>
  )
}

export function saveStatusLabel(state: string) {
  if (state === 'saving') return 'Saving'
  if (state === 'saved') return 'Saved'
  return ''
}
