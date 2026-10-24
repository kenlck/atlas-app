import { describe, expect, it } from 'vitest'
import { formatDateLabel, shiftIso, todayIso } from '../src/lib/date-label'

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
})
