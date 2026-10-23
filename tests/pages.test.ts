import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/lib/http'
import {
  archivePage,
  createPage,
  getPageView,
  listPageTree,
  movePage,
} from '../src/lib/pages'
import { createUser } from './helpers'

describe('pages', () => {
  it('nests pages, rejects cycles, and hides children of archived parents', async () => {
    const owner = await createUser('Owner')
    const parent = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Parent',
    })
    const child = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      parentId: parent.id,
      title: 'Child',
    })

    const tree = await listPageTree(owner.user.id, owner.space.id)
    expect(tree.tree).toHaveLength(1)
    expect(tree.tree[0]?.children[0]?.id).toBe(child.id)

    await expect(
      movePage(owner.user.id, { pageId: parent.id, parentId: child.id }),
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<HttpError>)

    await expect(
      movePage(owner.user.id, { pageId: parent.id, parentId: parent.id }),
    ).rejects.toMatchObject({ status: 400 })

    await archivePage(owner.user.id, parent.id)
    const after = await listPageTree(owner.user.id, owner.space.id)
    expect(after.tree).toHaveLength(0)

    await expect(getPageView(owner.user.id, parent.id)).rejects.toMatchObject({ status: 404 })
    await expect(getPageView(owner.user.id, child.id)).rejects.toMatchObject({ status: 404 })
  })
})
