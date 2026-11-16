import { describe, expect, it } from 'vitest'
import { clampTitle, nextTitle } from '../src/lib/title-cap'

const legacy = 'L'.repeat(250)

describe('clampTitle', () => {
  it('keeps a 250-character title on blur, typing, and paste, and allows shrinking', () => {
    expect(clampTitle(legacy, legacy)).toBe(legacy)
    expect(nextTitle(legacy, legacy, 'blur')).toBe(legacy)
    expect(nextTitle(legacy, `${legacy}Q`, 'blur')).toBe(`${legacy}Q`)
    expect(clampTitle(legacy, `${legacy}Q`)).toBe(legacy)
    expect(nextTitle(legacy, `${legacy}Q`, 'input')).toBe(legacy)
    expect(clampTitle(legacy, `${legacy}${'Z'.repeat(40)}`)).toBe(legacy)
    expect(nextTitle(legacy, `${legacy}${'Z'.repeat(40)}`, 'input')).toBe(legacy)
    expect(clampTitle(legacy, legacy.slice(0, 249))).toBe(legacy.slice(0, 249))
    expect(clampTitle(legacy, '')).toBe('')
    expect(clampTitle('c'.repeat(200), `${'c'.repeat(200)}Z`)).toBe('c'.repeat(200))
    expect(clampTitle('short', 'b'.repeat(250))).toBe('b'.repeat(200))
  })
})
