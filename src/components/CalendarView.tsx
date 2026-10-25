import { useEffect, useState } from 'react'
import { agendaWhen, layoutBars, monthGrid } from '#/lib/calendar-layout'
import {
  instantToLocalInput,
  localInputToInstant,
  parseMonth,
  shiftMonth,
  type CalendarEventJson,
} from '#/lib/calendar-time'
import { formatMonthYear, todayIso } from '#/lib/date-label'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

type Draft = {
  title: string
  allDay: boolean
  start: string
  end: string
  note: string
}

function currentMonth() {
  return todayIso().slice(0, 7)
}

function blankDraft(month: string): Draft {
  const today = todayIso()
  const day = today.startsWith(month) ? today : `${month}-01`
  return {
    title: '',
    allDay: false,
    start: `${day}T09:00`,
    end: `${day}T10:00`,
    note: '',
  }
}

function draftFromEvent(event: CalendarEventJson, timeZone: string): Draft {
  if (event.allDay) {
    return {
      title: event.title,
      allDay: true,
      start: event.startDate ?? '',
      end: event.endDate ?? '',
      note: event.note ?? '',
    }
  }
  return {
    title: event.title,
    allDay: false,
    start: instantToLocalInput(event.startAt ?? '', timeZone),
    end: instantToLocalInput(event.endAt ?? '', timeZone),
    note: event.note ?? '',
  }
}

function messageOf(body: { error?: string }, fallback: string) {
  return body.error || fallback
}

export function CalendarView({ teamId }: { teamId: string }) {
  const [timeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
  const [month, setMonth] = useState(currentMonth)
  const [events, setEvents] = useState<CalendarEventJson[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(() => blankDraft(currentMonth()))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ month, timeZone })
    fetch(`/api/atlas/teams/${teamId}/calendar?${params}`, {
      credentials: 'same-origin',
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
          events?: CalendarEventJson[]
        }
        if (!response.ok)
          throw new Error(messageOf(body, 'Could not load the calendar.'))
        return body.events ?? []
      })
      .then((next) => {
        if (!cancelled) setEvents(next)
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not load the calendar.',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [teamId, month, timeZone])

  const reload = async () => {
    const params = new URLSearchParams({ month, timeZone })
    const response = await fetch(
      `/api/atlas/teams/${teamId}/calendar?${params}`,
      {
        credentials: 'same-origin',
      },
    )
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      events?: CalendarEventJson[]
    }
    if (!response.ok)
      throw new Error(messageOf(body, 'Could not load the calendar.'))
    setEvents(body.events ?? [])
  }

  const parsed = parseMonth(month)
  const days = monthGrid(month)
  const bars = layoutBars(events, month, timeZone)
  const label = parsed ? formatMonthYear(parsed.year, parsed.month) : month

  const selectEvent = (eventId: string) => {
    const event = events.find((item) => item.id === eventId)
    if (!event) return
    setEditingId(event.id)
    setDraft(draftFromEvent(event, timeZone))
    setFormError(null)
  }

  const startNew = () => {
    setEditingId(null)
    setDraft(blankDraft(month))
    setFormError(null)
  }

  const toggleAllDay = (allDay: boolean) => {
    setDraft((current) => {
      if (allDay === current.allDay) return current
      if (allDay) {
        return {
          ...current,
          allDay,
          start: current.start.slice(0, 10),
          end: current.end.slice(0, 10),
        }
      }
      return {
        ...current,
        allDay,
        start: `${current.start.slice(0, 10)}T09:00`,
        end: `${current.end.slice(0, 10)}T10:00`,
      }
    })
  }

  const submit = async () => {
    setSaving(true)
    setFormError(null)
    let payload: Record<string, unknown>
    if (draft.allDay) {
      payload = {
        title: draft.title,
        allDay: true,
        startDate: draft.start,
        endDate: draft.end,
        note: draft.note,
      }
    } else {
      const startAt = localInputToInstant(draft.start, timeZone)
      const endAt = localInputToInstant(draft.end, timeZone)
      if (!startAt || !endAt) {
        setFormError('Bad request')
        setSaving(false)
        return
      }
      payload = {
        title: draft.title,
        allDay: false,
        startAt,
        endAt,
        note: draft.note,
      }
    }
    const path = editingId
      ? `/api/atlas/teams/${teamId}/calendar/events/${editingId}`
      : `/api/atlas/teams/${teamId}/calendar/events`
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      if (!response.ok) {
        setFormError(messageOf(body, 'Could not save the event.'))
        return
      }
      await reload()
      if (!editingId) startNew()
    } catch (caught) {
      setFormError(
        caught instanceof Error ? caught.message : 'Could not save the event.',
      )
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!editingId) return
    setSaving(true)
    setFormError(null)
    try {
      const response = await fetch(
        `/api/atlas/teams/${teamId}/calendar/events/${editingId}`,
        { method: 'DELETE', credentials: 'same-origin' },
      )
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      if (!response.ok) {
        setFormError(messageOf(body, 'Could not delete the event.'))
        return
      }
      await reload()
      startNew()
    } catch (caught) {
      setFormError(
        caught instanceof Error
          ? caught.message
          : 'Could not delete the event.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="top">
        <b className="cal-month-label">{label}</b>
        <div className="r">
          <button
            className="cal-nav"
            type="button"
            onClick={() => setMonth(currentMonth())}
          >
            Today
          </button>
          <button
            className="cal-nav"
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth((value) => shiftMonth(value, -1))}
          >
            ‹
          </button>
          <button
            className="cal-nav"
            type="button"
            aria-label="Next month"
            onClick={() => setMonth((value) => shiftMonth(value, 1))}
          >
            ›
          </button>
        </div>
      </div>
      <div className="cal">
        <div className="cal-board">
          {error ? (
            <div className="col">
              <div className="banner">{error}</div>
            </div>
          ) : null}
          <div className="cal-grid" data-month={month}>
            <div className="cal-dow">
              {WEEKDAYS.map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            {Array.from({ length: 6 }, (_, week) => {
              const weekDays = days.slice(week * 7, week * 7 + 7)
              const weekBars = bars.filter((bar) => bar.week === week)
              const laneCount = weekBars.reduce(
                (max, bar) => Math.max(max, bar.lane + 1),
                0,
              )
              return (
                <div className="cal-week" key={weekDays[0] ?? week}>
                  <div className="cal-dates">
                    {weekDays.map((iso) => {
                      const inMonth = iso.startsWith(month)
                      const today = iso === todayIso()
                      return (
                        <div
                          key={iso}
                          className={
                            today
                              ? 'cal-date today'
                              : inMonth
                                ? 'cal-date'
                                : 'cal-date out'
                          }
                          data-date={iso}
                        >
                          <span>{Number(iso.slice(8, 10))}</span>
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className="cal-lanes"
                    style={{
                      gridTemplateRows: `repeat(${Math.max(laneCount, 1)}, 22px)`,
                    }}
                  >
                    {weekBars.map((bar) => (
                      <button
                        key={`${bar.eventId}-${bar.week}`}
                        type="button"
                        className={
                          bar.eventId === editingId ? 'cal-bar on' : 'cal-bar'
                        }
                        data-event-id={bar.eventId}
                        data-start-col={bar.startCol}
                        data-end-col={bar.endCol}
                        data-crosses-month={bar.crossesMonth ? 'true' : 'false'}
                        style={{
                          gridColumn: `${bar.startCol + 1} / ${bar.endCol + 2}`,
                          gridRow: bar.lane + 1,
                        }}
                        onClick={() => selectEvent(bar.eventId)}
                      >
                        {bar.title}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
            {!loading && events.length === 0 ? (
              <p className="empty cal-empty">No events this month.</p>
            ) : null}
          </div>
          <div className="cal-agenda" aria-label="Agenda">
            {loading ? (
              <div className="skel" />
            ) : events.length === 0 ? (
              <p className="empty cal-empty">No events this month.</p>
            ) : (
              <ul>
                {events.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      className="cal-agenda-item"
                      data-event-id={event.id}
                      onClick={() => selectEvent(event.id)}
                    >
                      <span className="cal-agenda-when">
                        {agendaWhen(event, timeZone)}
                      </span>
                      <span className="cal-agenda-title">{event.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <aside
          className="cal-panel"
          aria-label={editingId ? 'Edit event' : 'Add event'}
        >
          <h2>{editingId ? 'Edit event' : 'Add event'}</h2>
          <label htmlFor="event-title">Title</label>
          <input
            id="event-title"
            className="in"
            value={draft.title}
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
          />
          <label className="cal-check" htmlFor="event-all-day">
            <input
              id="event-all-day"
              type="checkbox"
              checked={draft.allDay}
              onChange={(event) => toggleAllDay(event.target.checked)}
            />
            All day
          </label>
          <label htmlFor="event-start">Start</label>
          <input
            id="event-start"
            className="in"
            type={draft.allDay ? 'date' : 'datetime-local'}
            value={draft.start}
            onChange={(event) =>
              setDraft({ ...draft, start: event.target.value })
            }
          />
          <label htmlFor="event-end">End</label>
          <input
            id="event-end"
            className="in"
            type={draft.allDay ? 'date' : 'datetime-local'}
            value={draft.end}
            onChange={(event) =>
              setDraft({ ...draft, end: event.target.value })
            }
          />
          <label htmlFor="event-note">Note</label>
          <textarea
            id="event-note"
            className="in cal-note"
            value={draft.note}
            onChange={(event) =>
              setDraft({ ...draft, note: event.target.value })
            }
          />
          {formError ? <div className="err">{formError}</div> : null}
          <button
            className="btn"
            type="button"
            disabled={saving}
            onClick={() => void submit()}
          >
            {editingId ? 'Save' : 'Add event'}
          </button>
          {editingId ? (
            <button
              className="btn danger"
              type="button"
              disabled={saving}
              onClick={() => void remove()}
            >
              Delete
            </button>
          ) : null}
        </aside>
      </div>
    </>
  )
}
