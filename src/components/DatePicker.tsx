import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  formatMonthYear,
  monthMatrix,
  parseIso,
  shiftIso,
  todayIso,
} from '#/lib/date-label'
import {
  closeDatePicker,
  getDatePickerRequest,
  subscribeDatePicker,
  type DatePickerRequest,
} from '#/lib/date-picker-store'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function placePicker(anchor: DOMRect, width: number, height: number) {
  const gap = 8
  const edge = 16
  let left = anchor.left
  const maxLeft = window.innerWidth - edge - width
  left = Math.max(edge, Math.min(left, maxLeft))
  const below = anchor.bottom + gap
  const spaceBelow = window.innerHeight - below
  const openAbove = spaceBelow < height && anchor.top > spaceBelow
  const top = openAbove ? Math.max(edge, anchor.top - gap - height) : below
  return { left, top }
}

function Picker({ request }: { request: DatePickerRequest }) {
  const pickerRef = useRef<HTMLDivElement>(null)
  const parts = parseIso(request.date)
  const [cursor, setCursor] = useState(request.date)
  const [visible, setVisible] = useState(() =>
    parts ? { year: parts.year, month: parts.month } : { year: 2026, month: 1 },
  )
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null)

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (request.chip.contains(target) || pickerRef.current?.contains(target)) return
      closeDatePicker(request.id)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeDatePicker(request.id)
      request.focusChip()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [request])

  useLayoutEffect(() => {
    const place = () => {
      const anchor = request.chip.getBoundingClientRect()
      const picker = pickerRef.current
      if (!picker) return
      const width = Math.min(252, window.innerWidth - 32)
      setBox({ ...placePicker(anchor, width, picker.offsetHeight), width })
    }
    place()
    const doc = document.querySelector('.doc')
    doc?.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    return () => {
      doc?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [request, visible.year, visible.month])

  useEffect(() => {
    const button = pickerRef.current?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)
    button?.focus()
  }, [cursor, visible.year, visible.month])

  const pick = (iso: string) => {
    if (!parseIso(iso)) return
    request.pick(iso)
    closeDatePicker(request.id)
    request.focusChip()
  }

  const days = monthMatrix(visible.year, visible.month)
  const today = todayIso()
  const monthPrefix = `${visible.year}-${String(visible.month).padStart(2, '0')}`

  return createPortal(
    <div
      ref={pickerRef}
      className="menu date-picker"
      role="dialog"
      aria-label="Date"
      style={{
        left: box?.left ?? 0,
        top: box?.top ?? 0,
        width: box?.width ?? undefined,
        visibility: box ? 'visible' : 'hidden',
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeDatePicker(request.id)
          request.focusChip()
          return
        }
        const step =
          event.key === 'ArrowLeft'
            ? -1
            : event.key === 'ArrowRight'
              ? 1
              : event.key === 'ArrowUp'
                ? -7
                : event.key === 'ArrowDown'
                  ? 7
                  : 0
        if (step !== 0) {
          event.preventDefault()
          const next = shiftIso(cursor, step)
          const nextParts = parseIso(next)
          setCursor(next)
          if (nextParts) setVisible({ year: nextParts.year, month: nextParts.month })
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          pick(cursor)
        }
      }}
    >
      <div className="date-picker-head">
        <span className="date-picker-title">{formatMonthYear(visible.year, visible.month)}</span>
        <span className="date-picker-nav">
          <button
            type="button"
            className="ghost"
            aria-label="Previous month"
            onClick={() =>
              setVisible((current) =>
                current.month === 1
                  ? { year: current.year - 1, month: 12 }
                  : { year: current.year, month: current.month - 1 },
              )
            }
          >
            ‹
          </button>
          <button
            type="button"
            className="ghost"
            aria-label="Next month"
            onClick={() =>
              setVisible((current) =>
                current.month === 12
                  ? { year: current.year + 1, month: 1 }
                  : { year: current.year, month: current.month + 1 },
              )
            }
          >
            ›
          </button>
        </span>
      </div>
      <div className="date-weekdays">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="date-grid">
        {days.map((iso) => {
          const day = parseIso(iso)?.day
          const outside = !iso.startsWith(monthPrefix)
          const className = [
            'date-day',
            outside ? 'outside' : '',
            iso === today ? 'today' : '',
            iso === request.date ? 'selected' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <button
              key={iso}
              type="button"
              className={className}
              data-date={iso}
              tabIndex={iso === cursor ? 0 : -1}
              onClick={() => pick(iso)}
            >
              {day}
            </button>
          )
        })}
      </div>
      <div className="date-picker-foot">
        <button type="button" className="ghost" onClick={() => pick(todayIso())}>
          Today
        </button>
        <button
          type="button"
          className="date-remove"
          onClick={() => {
            closeDatePicker(request.id)
            request.remove()
          }}
        >
          Remove date
        </button>
      </div>
    </div>,
    document.body,
  )
}

export function DatePickerHost() {
  const request = useSyncExternalStore(subscribeDatePicker, getDatePickerRequest, () => null)
  if (!request) return null
  return <Picker key={request.id} request={request} />
}
