import { formatDateLabel, monthMatrix } from './date-label'
import {
  clockInZone,
  firstDateOfMonth,
  formatClock,
  lastDateOfMonth,
  parseMonth,
  type CalendarEventJson,
} from './calendar-time'

export type BarSegment = {
  eventId: string
  title: string
  week: number
  startCol: number
  endCol: number
  lane: number
  crossesMonth: boolean
}

export function eventDateRange(event: CalendarEventJson, timeZone: string) {
  if (event.allDay) {
    if (!event.startDate || !event.endDate) return null
    return { start: event.startDate, end: event.endDate }
  }
  if (!event.startAt || !event.endAt) return null
  const start = clockInZone(event.startAt, timeZone).date
  const end = clockInZone(event.endAt, timeZone).date
  return { start, end }
}

export function agendaWhen(event: CalendarEventJson, timeZone: string) {
  const range = eventDateRange(event, timeZone)
  if (!range) return ''
  if (event.allDay) {
    if (range.start === range.end) return formatDateLabel(range.start)
    return `${formatDateLabel(range.start)} – ${formatDateLabel(range.end)}`
  }
  const start = clockInZone(event.startAt ?? '', timeZone)
  const end = clockInZone(event.endAt ?? '', timeZone)
  const startClock = formatClock(start.parts.hour, start.parts.minute)
  const endClock = formatClock(end.parts.hour, end.parts.minute)
  if (range.start === range.end) {
    return `${formatDateLabel(range.start)}, ${startClock} – ${endClock}`
  }
  return `${formatDateLabel(range.start)}, ${startClock} – ${formatDateLabel(range.end)}, ${endClock}`
}

function clipWeek(start: string, end: string, days: string[]) {
  const first = days[0]
  const last = days[6]
  if (!first || !last) return null
  if (end < first || start > last) return null
  const startCol = start <= first ? 0 : days.indexOf(start)
  const endCol = end >= last ? 6 : days.indexOf(end)
  if (startCol < 0 || endCol < 0 || endCol < startCol) return null
  return { startCol, endCol }
}

export function layoutBars(
  events: CalendarEventJson[],
  month: string,
  timeZone: string,
) {
  const parsed = parseMonth(month)
  if (!parsed) return []
  const days = monthMatrix(parsed.year, parsed.month)
  const monthStart = firstDateOfMonth(parsed.year, parsed.month)
  const monthEnd = lastDateOfMonth(parsed.year, parsed.month)
  const placed: BarSegment[] = []
  for (let week = 0; week < 6; week += 1) {
    const weekDays = days.slice(week * 7, week * 7 + 7)
    const lanes: Array<Array<{ startCol: number; endCol: number }>> = []
    const segments: BarSegment[] = []
    for (const event of events) {
      const range = eventDateRange(event, timeZone)
      if (!range) continue
      const clip = clipWeek(range.start, range.end, weekDays)
      if (!clip) continue
      segments.push({
        eventId: event.id,
        title: event.title,
        week,
        startCol: clip.startCol,
        endCol: clip.endCol,
        lane: 0,
        crossesMonth: range.start < monthStart || range.end > monthEnd,
      })
    }
    segments.sort(
      (a, b) => a.startCol - b.startCol || a.title.localeCompare(b.title),
    )
    for (const segment of segments) {
      let lane = lanes.findIndex((occupied) =>
        occupied.every(
          (item) =>
            item.endCol < segment.startCol || item.startCol > segment.endCol,
        ),
      )
      if (lane < 0) {
        lane = lanes.length
        lanes.push([])
      }
      lanes[lane]?.push({ startCol: segment.startCol, endCol: segment.endCol })
      segment.lane = lane
      placed.push(segment)
    }
  }
  return placed
}

export function monthGrid(month: string) {
  const parsed = parseMonth(month)
  if (!parsed) return []
  return monthMatrix(parsed.year, parsed.month)
}
