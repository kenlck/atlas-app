import { describe, expect, it } from 'vitest'
import { DateChip } from '../src/lib/date-chip'

function dateSpec() {
  const add = DateChip.config.addAttributes
  if (!add) throw new Error('date chip has no attributes')
  const spec = add.call(DateChip).date
  if (!spec?.parseHTML || !spec.renderHTML) throw new Error('date attribute is incomplete')
  return spec
}

describe('date chip attribute', () => {
  it('accepts only a valid YYYY-MM-DD from data-date', () => {
    const spec = dateSpec()
    const element = (value: string | null) =>
      ({
        getAttribute: (name: string) => (name === 'data-date' ? value : null),
      }) as HTMLElement
    expect(spec.parseHTML?.(element('2026-01-15'))).toBe('2026-01-15')
    expect(spec.parseHTML?.(element('2024-02-29'))).toBe('2024-02-29')
    expect(spec.parseHTML?.(element('2026-02-31'))).toBeNull()
    expect(spec.parseHTML?.(element('2026-02-29'))).toBeNull()
    expect(spec.parseHTML?.(element('nope'))).toBeNull()
    expect(spec.renderHTML?.({ date: '2026-02-31' })).toEqual({})
    expect(spec.renderHTML?.({ date: '2026-01-15' })).toEqual({ 'data-date': '2026-01-15' })
  })

  it('rejects a span whose data-date is not a valid ISO day', () => {
    const parse = DateChip.config.parseHTML
    if (!parse) throw new Error('date chip has no parseHTML')
    const rule = parse.call(DateChip).find((item) => item.tag === 'span[data-date]')
    if (!rule?.getAttrs) throw new Error('span[data-date] does not reject invalid dates')
    const element = (value: string) =>
      ({
        getAttribute: (name: string) => (name === 'data-date' ? value : null),
      }) as HTMLElement
    expect(rule.getAttrs(element('2026-01-15'))).toEqual({ date: '2026-01-15' })
    expect(rule.getAttrs(element('2024-02-29'))).toEqual({ date: '2024-02-29' })
    expect(rule.getAttrs(element('2026-03-04T09:00:00Z'))).toBe(false)
    expect(rule.getAttrs(element('Friday'))).toBe(false)
    expect(rule.getAttrs(element('2026-02-31'))).toBe(false)
  })
})
