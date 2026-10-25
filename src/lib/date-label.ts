const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export type IsoParts = { year: number; month: number; day: number }

function daysInMonth(year: number, month: number) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return lengths[month - 1] ?? 0
}

export function parseIso(iso: string): IsoParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

export function dateAttribute(value: unknown) {
  if (typeof value !== 'string' || !parseIso(value)) return null
  return value
}

export function findDayButton<T extends { getAttribute(name: string): string | null }>(
  buttons: Iterable<T>,
  iso: string,
) {
  if (!parseIso(iso)) return null
  for (const button of buttons) {
    if (button.getAttribute('data-date') === iso) return button
  }
  return null
}

export function isoFromDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayIso(now = new Date()) {
  return isoFromDate(now)
}

export function formatDateLabel(iso: string) {
  const parts = parseIso(iso)
  if (!parts) return iso
  return `${SHORT_MONTHS[parts.month - 1]} ${parts.day}, ${parts.year}`
}

export function formatMonthYear(year: number, month: number) {
  return `${MONTH_NAMES[month - 1]} ${year}`
}

export function shiftIso(iso: string, days: number) {
  const parts = parseIso(iso)
  if (!parts) return iso
  const date = new Date(parts.year, parts.month - 1, parts.day + days)
  return isoFromDate(date)
}

export function monthMatrix(year: number, month: number) {
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const start = new Date(year, month - 1, 1 - firstWeekday)
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    return isoFromDate(day)
  })
}
