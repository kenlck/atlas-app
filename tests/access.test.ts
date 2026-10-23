import { describe, expect, it } from 'vitest'
import { assertAccess } from '../src/lib/access'
import { HttpError } from '../src/lib/http'
import { createPage } from '../src/lib/pages'
import { createUser } from './helpers'

describe('assertAccess', () => {
  it('allows the owner of a personal space and 404s everyone else', async () => {
    const a = await createUser('Ava')
    const b = await createUser('Bea')
    const allowed = await assertAccess(a.user.id, { spaceId: a.space.id })
    expect(allowed.space.id).toBe(a.space.id)

    await expect(assertAccess(b.user.id, { spaceId: a.space.id })).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<HttpError>)

    const page = await createPage(a.user.id, { spaceId: a.space.id, title: 'Private' })
    await expect(assertAccess(b.user.id, { pageId: page.id })).rejects.toMatchObject({
      status: 404,
    })
    await expect(assertAccess(a.user.id, { pageId: 'missing-page' })).rejects.toMatchObject({
      status: 404,
    })
  })
})
