import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '../src/lib/db'
import { HttpError } from '../src/lib/http'
import {
  archivePage,
  createPage,
  getPageView,
  listPageTree,
  movePage,
  type TreeNode,
} from '../src/lib/pages'
import { page } from '../src/lib/schema'
import { createUser } from './helpers'

function collectTreeIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...collectTreeIds(node.children)])
}

function parentCycle(
  rows: Array<{ id: string; parentId: string | null }>,
) {
  const byId = new Map(rows.map((row) => [row.id, row.parentId]))
  for (const start of byId.keys()) {
    const seen = new Set<string>()
    let current: string | null | undefined = start
    while (current) {
      if (seen.has(current)) return true
      seen.add(current)
      current = byId.get(current) ?? null
    }
  }
  return false
}

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

  it('serializes concurrent inverse moves so one wins, the other is rejected, and no cycle remains', async () => {
    let won = 0
    let rejected = 0
    let other = 0
    const runs = 20
    for (let i = 0; i < runs; i += 1) {
      const owner = await createUser(`Move ${i}`)
      const a = await createPage(owner.user.id, { spaceId: owner.space.id, title: 'A' })
      const b = await createPage(owner.user.id, { spaceId: owner.space.id, title: 'B' })
      const results = await Promise.allSettled([
        movePage(owner.user.id, { pageId: a.id, parentId: b.id }),
        movePage(owner.user.id, { pageId: b.id, parentId: a.id }),
      ])
      const statuses = results.map((result) => {
        if (result.status === 'fulfilled') {
          won += 1
          return 200
        }
        const status = (result.reason as HttpError | undefined)?.status
        if (status === 400) {
          rejected += 1
          return 400
        }
        other += 1
        return status ?? 0
      })
      expect([...statuses].sort((left, right) => left - right)).toEqual([200, 400])

      const tree = await listPageTree(owner.user.id, owner.space.id)
      const inTree = collectTreeIds(tree.tree)
      expect(inTree).toEqual(expect.arrayContaining([a.id, b.id]))
      expect(inTree).toHaveLength(2)
      await expect(getPageView(owner.user.id, a.id)).resolves.toMatchObject({ id: a.id })
      await expect(getPageView(owner.user.id, b.id)).resolves.toMatchObject({ id: b.id })
      const rows = await getDb()
        .select({ id: page.id, parentId: page.parentId })
        .from(page)
        .where(eq(page.spaceId, owner.space.id))
      expect(parentCycle(rows)).toBe(false)
    }
    expect({ runs, won, rejected, other }).toEqual({ runs, won: runs, rejected: runs, other: 0 })
  }, 120_000)
})
