import { describe, expect, it } from 'vitest'
import { lockedAuthPathAllowed } from '../src/lib/gate'

describe('lockedAuthPathAllowed', () => {
  it('allows get-session, sign-out and change-password only', () => {
    expect(lockedAuthPathAllowed('/api/auth/get-session')).toBe(true)
    expect(lockedAuthPathAllowed('/api/auth/sign-out')).toBe(true)
    expect(lockedAuthPathAllowed('/api/auth/change-password')).toBe(true)
    expect(lockedAuthPathAllowed('/api/auth/update-user')).toBe(false)
    expect(lockedAuthPathAllowed('/api/auth/list-sessions')).toBe(false)
    expect(lockedAuthPathAllowed('/api/auth/list-accounts')).toBe(false)
  })
})
