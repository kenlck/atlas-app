const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

export type CivilParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export type CalendarEventJson = {
  id: string
  title: string
  allDay: boolean
  startAt: string | null
  endAt: string | null
  startDate: string | null
  endDate: string | null
  note: string | null
}

export function isTimeZone(timeZone: string) {
  if (!timeZone || timeZone.length > 120) return false
  try {
    Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function daysInMonth(year: number, month: number) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return lengths[month - 1] ?? 0
}

export function isCivilDate(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

export function parseMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null
  return { year, month }
}

export function monthKey(year: number, month: number) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

export function shiftMonth(month: string, delta: number) {
  const parsed = parseMonth(month)
  if (!parsed) return month
  const index = parsed.year * 12 + (parsed.month - 1) + delta
  const year = Math.floor(index / 12)
  const next = index - year * 12
  return monthKey(year, next + 1)
}

export function firstDateOfMonth(year: number, month: number) {
  return `${monthKey(year, month)}-01`
}

export function lastDateOfMonth(year: number, month: number) {
  return `${monthKey(year, month)}-${String(daysInMonth(year, month)).padStart(2, '0')}`
}

function readParts(instant: Date, timeZone: string): CivilParts {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const map: Record<string, string> = {}
  for (const part of formatted) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  let hour = Number(map.hour)
  let day = Number(map.day)
  let month = Number(map.month)
  let year = Number(map.year)
  if (hour === 24) {
    hour = 0
    const rolled = new Date(Date.UTC(year, month - 1, day))
    rolled.setUTCDate(rolled.getUTCDate() + 1)
    year = rolled.getUTCFullYear()
    month = rolled.getUTCMonth() + 1
    day = rolled.getUTCDate()
  }
  return {
    year,
    month,
    day,
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

export function instantParts(instant: Date, timeZone: string) {
  return readParts(instant, timeZone)
}

function offsetMs(instant: Date, timeZone: string) {
  const parts = readParts(instant, timeZone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return asUtc - instant.getTime()
}

export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const first = new Date(wall - offsetMs(new Date(wall), timeZone))
  return new Date(wall - offsetMs(first, timeZone))
}

export function monthBounds(year: number, month: number, timeZone: string) {
  const start = zonedDateTimeToUtc(year, month, 1, 0, 0, 0, timeZone)
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const end = zonedDateTimeToUtc(nextYear, nextMonth, 1, 0, 0, 0, timeZone)
  return { start, end }
}

export function partsToIso(parts: {
  year: number
  month: number
  day: number
}) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function parseInstant(value: string) {
  const match = INSTANT.exec(value)
  if (!match) return null
  const date = `${match[1]}-${match[2]}-${match[3]}`
  if (!isCivilDate(date)) return null
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? '0')
  if (hour > 23 || minute > 59 || second > 59) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

export function localInputToInstant(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match || !isTimeZone(timeZone)) return null
  if (!isCivilDate(value.slice(0, 10))) return null
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (hour > 23 || minute > 59) return null
  return zonedDateTimeToUtc(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    hour,
    minute,
    0,
    timeZone,
  ).toISOString()
}

export function instantToLocalInput(iso: string, timeZone: string) {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime()) || !isTimeZone(timeZone)) return ''
  const parts = readParts(instant, timeZone)
  const clock = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  return `${partsToIso(parts)}T${clock}`
}

export function formatClock(hour: number, minute: number) {
  const suffix = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`
}

export function clockInZone(iso: string, timeZone: string) {
  const instant = new Date(iso)
  const parts = readParts(instant, timeZone)
  return {
    date: partsToIso(parts),
    clock: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    parts,
  }
}
