import { describe, expect, it } from 'vitest'
import {
  dateAttribute,
  findDayButton,
  formatDateLabel,
  parseIso,
  shiftIso,
  todayIso,
} from '../src/lib/date-label'

describe('date labels', () => {
  it('formats a stored day from its parts', () => {
    expect(formatDateLabel('2026-01-15')).toBe('Jan 15, 2026')
    expect(formatDateLabel('2026-10-23')).toBe('Oct 23, 2026')
    expect(formatDateLabel('2026-03-01')).toBe('Mar 1, 2026')
  })

  it('keeps the same label for a UTC midnight instant that would shift in US time', () => {
    const iso = '2026-01-15'
    expect(formatDateLabel(iso)).toBe('Jan 15, 2026')
    expect(new Date(`${iso}T00:00:00.000Z`).getUTCDate()).toBe(15)
  })

  it('reads today from the local calendar parts', () => {
    expect(todayIso(new Date(2026, 0, 15, 23, 30))).toBe('2026-01-15')
    expect(shiftIso('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('rejects dates that are not real calendar days', () => {
    expect(parseIso('2026-02-31')).toBeNull()
    expect(parseIso('2026-04-31')).toBeNull()
    expect(parseIso('2026-02-29')).toBeNull()
    expect(parseIso('1900-02-29')).toBeNull()
    expect(parseIso('2026-13-01')).toBeNull()
    expect(parseIso('2026-00-10')).toBeNull()
    expect(parseIso('2026-02-00')).toBeNull()
    expect(formatDateLabel('2026-02-31')).toBe('2026-02-31')
    expect(parseIso('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 })
    expect(parseIso('2000-02-29')).toEqual({ year: 2000, month: 2, day: 29 })
    expect(parseIso('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 })
  })

  it('keeps only a valid YYYY-MM-DD attribute', () => {
    expect(dateAttribute('2026-01-15')).toBe('2026-01-15')
    expect(dateAttribute('2024-02-29')).toBe('2024-02-29')
    expect(dateAttribute('2026-02-31')).toBeNull()
    expect(dateAttribute('2026-02-29')).toBeNull()
    expect(dateAttribute('2026-2-01')).toBeNull()
    expect(dateAttribute('not-a-date')).toBeNull()
    expect(dateAttribute(null)).toBeNull()
    expect(dateAttribute('')).toBeNull()
  })

  it('finds a day button by attribute equality', () => {
    const invalid = { getAttribute: (name: string) => (name === 'data-date' ? '2026-02-31' : null) }
    const valid = { getAttribute: (name: string) => (name === 'data-date' ? '2026-02-28' : null) }
    expect(findDayButton([invalid, valid], '2026-02-31')).toBeNull()
    expect(findDayButton([invalid, valid], '2026-02-29')).toBeNull()
    expect(findDayButton([invalid, valid], '2026-02-28"]')).toBeNull()
    expect(findDayButton([invalid, valid], '2026-02-28')).toBe(valid)
  })
})
