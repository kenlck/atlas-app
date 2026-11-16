import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiToken } from '../src/lib/api-tokens'
import { getDb } from '../src/lib/db'
import {
  DRAWING_MAX_BYTES,
  WHITEBOARD_PLACEHOLDER,
  canonicalElements,
  drawingLabelText,
  sceneChanged,
  sceneFollowup,
  sceneRejection,
  userSceneChanged,
} from '../src/lib/drawing'
import { handleDrawingRequest } from '../src/lib/drawing-request'
import { handleMcp } from '../src/lib/mcp'
import {
  archivePage,
  createDiagram,
  createPage,
  getPageView,
  listPageTree,
  savePage,
} from '../src/lib/pages'
import { searchVisiblePages } from '../src/lib/search'
import { drawing, page } from '../src/lib/schema'
import { createUser } from './helpers'

const SECRET = 'secretneedle'
const LABEL = 'roadmap'

function scene() {
  return [
    { id: SECRET, type: 'rectangle', text: SECRET, x: 1, y: 2 },
    { id: 'label-1', type: 'text', text: LABEL, x: 3, y: 4 },
    {
      id: 'arrow-1',
      type: 'arrow',
      points: [
        [0, 0],
        [8, 8],
      ],
    },
  ]
}

function post(token: string, body: string | object) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return handleDrawingRequest(
    new Request('http://127.0.0.1/api/drawings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: raw,
    }),
  )
}

function get(token: string, query: string) {
  return handleDrawingRequest(
    new Request(`http://127.0.0.1/api/drawings?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  )
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const response = await handleMcp(
    new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  )
  const text = await response.text()
  const payload = JSON.parse(text) as {
    result?: { content?: Array<{ text?: string }> }
    error?: { message?: string }
  }
  return {
    status: response.status,
    error: payload.error?.message ?? '',
    data: JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as {
      body?: string
      title?: string
      updated_at?: string
    },
  }
}

describe('drawings', () => {
  it('indexes text labels and rejects images', () => {
    expect(drawingLabelText(scene())).toBe(LABEL)
    expect(sceneRejection({ files: { a: { id: 'a' } }, elements: [] })).toBe(
      'files',
    )
    expect(
      sceneRejection({
        files: {},
        elements: [{ type: 'image', id: 'img' }],
      }),
    ).toBe('image')
    expect(sceneRejection({ files: {}, elements: scene() })).toBeNull()
  })

  it('hides a board from outsiders and keeps the scene on conflict', async () => {
    const owner = await createUser('Board Owner')
    const outsider = await createUser('Board Outsider')
    const board = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Plan',
      kind: 'whiteboard',
    })
    expect(board.drawing?.version).toBe(1)
    const ownerToken = await createApiToken(owner.user.id, {
      name: 'owner',
      scope: 'read_write',
      expiry: '30d',
    })
    const outsiderToken = await createApiToken(outsider.user.id, {
      name: 'outsider',
      scope: 'read_write',
      expiry: '30d',
    })
    const saved = await post(ownerToken.token, {
      pageId: board.id,
      version: 1,
      elements: scene(),
      appState: {},
      files: {},
    })
    expect(saved.status).toBe(200)

    const missing = await get(ownerToken.token, 'pageId=missing-page')
    const byPage = await get(outsiderToken.token, `pageId=${board.id}`)
    const byDrawing = await get(
      outsiderToken.token,
      `drawingId=${board.drawing?.id}`,
    )
    expect(missing.status).toBe(404)
    expect(byPage.status).toBe(404)
    expect(byDrawing.status).toBe(404)
    expect(await byPage.text()).toBe(await missing.text())

    const posted = await post(outsiderToken.token, {
      drawingId: board.drawing?.id,
      version: 2,
      elements: scene(),
      appState: {},
    })
    expect(posted.status).toBe(404)

    const tooBig = 'x'.repeat(DRAWING_MAX_BYTES + 1)
    const oversize = await post(ownerToken.token, tooBig)
    expect(oversize.status).toBe(413)

    const files = await post(ownerToken.token, {
      pageId: board.id,
      version: 2,
      elements: [],
      appState: {},
      files: { a: { id: 'a' } },
    })
    const image = await post(ownerToken.token, {
      pageId: board.id,
      version: 2,
      elements: [{ id: 'img', type: 'image' }],
      appState: {},
      files: {},
    })
    expect(files.status).toBe(400)
    expect(image.status).toBe(400)

    const stale = await post(ownerToken.token, {
      pageId: board.id,
      version: 1,
      elements: [{ id: 'other', type: 'text', text: 'replaced' }],
      appState: {},
    })
    expect(stale.status).toBe(409)
    expect(await stale.text()).toContain('board changed, reload')

    const current = await get(ownerToken.token, `pageId=${board.id}`)
    const body = (await current.json()) as {
      version: number
      elements: unknown[]
    }
    expect(body.version).toBe(2)
    expect(canonicalElements(body.elements)).toBe(canonicalElements(scene()))

    const hits = await searchVisiblePages(owner.user.id, LABEL)
    expect(hits.some((hit) => hit.id === board.id)).toBe(true)
    const secretHits = await searchVisiblePages(owner.user.id, SECRET)
    expect(secretHits.some((hit) => hit.id === board.id)).toBe(false)
    const outsiderHits = await searchVisiblePages(outsider.user.id, 'Plan')
    expect(outsiderHits.some((hit) => hit.id === board.id)).toBe(false)
  })

  it('gives agents a placeholder and archives like a page', async () => {
    const owner = await createUser('Board Agent')
    const board = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Sketch',
      kind: 'whiteboard',
    })
    const child = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      parentId: board.id,
      title: 'Child note',
    })
    const token = await createApiToken(owner.user.id, {
      name: 'agent',
      scope: 'read_write',
      expiry: '30d',
    })
    await post(token.token, {
      pageId: board.id,
      version: 1,
      elements: scene(),
      appState: { viewBackgroundColor: 'white' },
    })
    const read = await mcp(token.token, 'read_page', { page_id: board.id })
    expect(read.status).toBe(200)
    expect(read.data.body).toBe(WHITEBOARD_PLACEHOLDER)
    const before = await getPageView(owner.user.id, board.id)
    const updated = await mcp(token.token, 'update_page', {
      page_id: board.id,
      title: 'Renamed sketch',
      body: 'agent tried to write the scene',
      updated_at: read.data.updated_at,
    })
    expect(updated.status).toBe(200)
    expect(updated.data.title).toBe('Renamed sketch')
    expect(updated.data.body).toBe(WHITEBOARD_PLACEHOLDER)
    const bodyOnly = await mcp(token.token, 'update_page', {
      page_id: board.id,
      body: 'still not the scene',
      updated_at: updated.data.updated_at,
    })
    expect(bodyOnly.status).toBe(200)
    expect(bodyOnly.data.title).toBe('Renamed sketch')
    const after = await getPageView(owner.user.id, board.id)
    expect(canonicalElements(after.drawing?.elements ?? [])).toBe(
      canonicalElements(before.drawing?.elements ?? []),
    )
    const titled = await savePage(owner.user.id, {
      pageId: board.id,
      title: 'Saved title',
      body: { type: 'doc', content: [] },
    })
    expect(titled.title).toBe('Saved title')
    expect(canonicalElements(titled.drawing?.elements ?? [])).toBe(
      canonicalElements(after.drawing?.elements ?? []),
    )

    await archivePage(owner.user.id, board.id)
    const tree = await listPageTree(owner.user.id, owner.space.id)
    const ids = JSON.stringify(tree)
    expect(ids.includes(board.id)).toBe(false)
    expect(ids.includes(child.id)).toBe(false)
    const archivedSearch = await searchVisiblePages(owner.user.id, LABEL)
    expect(archivedSearch.some((hit) => hit.id === board.id)).toBe(false)
    const archivedRead = await mcp(token.token, 'get_page', {
      page_id: board.id,
    })
    expect(archivedRead.status).toBe(404)
    const archivedDrawing = await get(token.token, `pageId=${board.id}`)
    expect(archivedDrawing.status).toBe(404)
    const row = await getDb()
      .select({ id: drawing.id })
      .from(drawing)
      .where(eq(drawing.pageId, board.id))
    expect(row.length).toBe(1)
  })

  it('leaves Edited by unchanged when a diagram save repeats the scene', async () => {
    const ada = await createUser('Diagram Ada')
    const bea = await createUser('Diagram Bea')
    const doc = await createPage(ada.user.id, {
      spaceId: ada.space.id,
      title: 'Diagram note',
    })
    const diagram = await createDiagram(ada.user.id, doc.id)
    const token = await createApiToken(ada.user.id, {
      name: 'diagram',
      scope: 'read_write',
      expiry: '30d',
    })
    const rect = [{ id: 'rect-1', type: 'rectangle', x: 1, y: 2 }]
    const first = await post(token.token, {
      drawingId: diagram.id,
      version: diagram.version,
      elements: rect,
      appState: {},
      files: {},
    })
    expect(first.status).toBe(200)
    const changed = await getDb()
      .select()
      .from(page)
      .where(eq(page.id, doc.id))
      .limit(1)
    expect(changed[0]?.lastEditedBy).toBe(ada.user.id)
    await getDb()
      .update(page)
      .set({
        lastEditedAt: new Date('2024-01-01T00:00:00Z'),
        lastEditedBy: bea.user.id,
      })
      .where(eq(page.id, doc.id))
    const saved = (await first.json()) as { version: number }
    const again = await post(token.token, {
      drawingId: diagram.id,
      version: saved.version,
      elements: rect,
      appState: {},
      files: {},
    })
    expect(again.status).toBe(200)
    const kept = await getDb()
      .select()
      .from(page)
      .where(eq(page.id, doc.id))
      .limit(1)
    expect(kept[0]?.lastEditedBy).toBe(bea.user.id)
    expect(kept[0]?.lastEditedAt?.toISOString()).toBe(
      '2024-01-01T00:00:00.000Z',
    )
    expect(kept[0]?.updatedBy).toBe(changed[0]?.updatedBy)
    expect(kept[0]?.updatedAt).toEqual(changed[0]?.updatedAt)
    const moved = await post(token.token, {
      drawingId: diagram.id,
      version: (await again.json()).version as number,
      elements: [{ id: 'rect-1', type: 'rectangle', x: 9, y: 2 }],
      appState: {},
      files: {},
    })
    expect(moved.status).toBe(200)
    const stamped = await getDb()
      .select()
      .from(page)
      .where(eq(page.id, doc.id))
      .limit(1)
    expect(stamped[0]?.lastEditedBy).toBe(ada.user.id)
    expect(stamped[0]?.lastEditedAt?.toISOString()).not.toBe(
      '2024-01-01T00:00:00.000Z',
    )
  })

  it('treats a repeated scene as unchanged and a reorder as a change', () => {
    const sparse = [{ id: 'rect-1', type: 'rectangle', x: 1, y: 2 }]
    const sized = [
      { id: 'rect-1', type: 'rectangle', x: 1, y: 2, width: 8, height: 4 },
    ]
    expect(sceneChanged(sparse, sparse)).toBe(false)
    expect(sceneChanged(sparse, sized)).toBe(true)
    const first = {
      id: 'a',
      type: 'rectangle',
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      index: 'a0',
    }
    const second = {
      id: 'b',
      type: 'rectangle',
      x: 5,
      y: 6,
      width: 3,
      height: 4,
      index: 'a1',
    }
    expect(sceneChanged([first, second], [second, first])).toBe(true)
    expect(sceneChanged([first, second], [first, second])).toBe(false)
  })
})

describe('scene edits a person made', () => {
  const text = {
    id: 'hello',
    type: 'text',
    x: 10,
    y: 12,
    text: 'Hello',
    fontSize: 20,
  }

  it('ignores font measurement, a filled index, and an image status', () => {
    expect(userSceneChanged([text], [{ ...text, width: 40, height: 24, baseline: 18 }])).toBe(
      false,
    )
    expect(
      userSceneChanged([text], [{ ...text, index: 'a0', originalText: 'Hello', lineHeight: 1.25 }]),
    ).toBe(false)
    const pending = { id: 'img', type: 'image', x: 1, y: 2, status: 'pending', fileId: 'f' }
    const saved = { ...pending, status: 'saved' }
    expect(userSceneChanged([pending], [saved])).toBe(false)
    expect(sceneFollowup([pending], [saved])).toBe('save')
    expect(sceneFollowup([text], [{ ...text, width: 80 }])).toBe('adopt')
    expect(userSceneChanged([text], [{ ...text, text: 'Hello!' }])).toBe(true)
    expect(userSceneChanged([text], [...[text], { id: 'extra', type: 'rectangle' }])).toBe(true)
  })

  it('counts an indexed reorder and a fixed-width text resize', () => {
    const front = { id: 'a', type: 'rectangle', x: 1, y: 2, index: 'a0' }
    const back = { id: 'b', type: 'rectangle', x: 5, y: 6, index: 'a1' }
    expect(
      userSceneChanged(
        [front, back],
        [
          { ...front, index: 'a1' },
          { ...back, index: 'a0' },
        ],
      ),
    ).toBe(true)
    const fixed = {
      id: 'label',
      type: 'text',
      text: 'Hello',
      x: 1,
      y: 2,
      width: 80,
      height: 24,
      baseline: 18,
      lineHeight: 1.25,
      autoResize: false,
    }
    expect(userSceneChanged([fixed], [{ ...fixed, width: 140 }])).toBe(true)
    expect(
      userSceneChanged(
        [{ ...fixed, autoResize: true, width: 80 }],
        [{ ...fixed, autoResize: true, width: 140 }],
      ),
    ).toBe(false)
  })
})
