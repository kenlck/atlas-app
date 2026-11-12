import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiToken } from '../src/lib/api-tokens'
import { getDb } from '../src/lib/db'
import { diagramIds, drawingLink } from '../src/lib/diagram'
import { cleanPreviewSvg, canonicalElements } from '../src/lib/drawing'
import { handleDrawingRequest } from '../src/lib/drawing-request'
import { markdownToTiptap, tiptapToMarkdown } from '../src/lib/markdown-body'
import { handleMcp } from '../src/lib/mcp'
import {
  archivePage,
  createDiagram,
  createPage,
  duplicatePage,
  getPageView,
  savePage,
} from '../src/lib/pages'
import { searchVisiblePages } from '../src/lib/search'
import { drawing, page } from '../src/lib/schema'
import { createUser } from './helpers'

const LABEL = 'diagramlabel'
const SECRET = 'scene-secret-needle'

function scene() {
  return [
    { id: SECRET, type: 'rectangle', text: SECRET, x: 1, y: 2 },
    { id: 'label-1', type: 'text', text: LABEL, x: 3, y: 4 },
  ]
}

function dirtySvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10" /></svg>`
}

function post(token: string, body: object) {
  return handleDrawingRequest(
    new Request('http://127.0.0.1/api/drawings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
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
  const payload = JSON.parse(await response.text()) as {
    result?: { content?: Array<{ text?: string }> }
  }
  return {
    status: response.status,
    data: JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as {
      body?: string
      title?: string
      updated_at?: string
    },
  }
}

describe('diagram blocks', () => {
  it('strips scripts and handlers from preview svg', () => {
    const cleaned = cleanPreviewSvg(dirtySvg())
    expect(cleaned).toBeTruthy()
    expect(cleaned).not.toContain('<script')
    expect(cleaned).not.toContain('onload')
    expect(cleaned).not.toContain('alert')
    expect(cleanPreviewSvg('<svg><script>alert(1)</script></svg>')).toBe('<svg></svg>')
  })

  it('keeps one drawing id per block and leaves the row when the block goes', async () => {
    const owner = await createUser('Diagram Owner')
    const outsider = await createUser('Diagram Outsider')
    const doc = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Diagram page',
    })
    const other = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Other page',
    })
    const created = await createDiagram(owner.user.id, doc.id)
    const second = await createDiagram(owner.user.id, doc.id)
    expect(created.id).not.toBe(second.id)
    const token = await createApiToken(owner.user.id, {
      name: 'owner',
      scope: 'read_write',
      expiry: '30d',
    })
    const outsiderToken = await createApiToken(outsider.user.id, {
      name: 'outsider',
      scope: 'read_write',
      expiry: '30d',
    })
    const saved = await post(token.token, {
      drawingId: created.id,
      version: 1,
      elements: scene(),
      appState: { [SECRET]: true },
      files: {},
      previewSvg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${SECRET}</text></svg>`,
    })
    expect(saved.status).toBe(200)

    const body = {
      type: 'doc',
      content: [
        { type: 'diagram', attrs: { drawingId: created.id } },
        { type: 'diagram', attrs: { drawingId: created.id } },
      ],
    }
    const stored = await savePage(owner.user.id, {
      pageId: doc.id,
      title: 'Diagram page',
      body,
    })
    const ids = diagramIds(stored.body)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(created.id)
    expect(ids[1]).not.toBe(created.id)
    const copy = await getDb()
      .select()
      .from(drawing)
      .where(eq(drawing.id, ids[1] ?? ''))
    expect(copy[0]?.pageId).toBe(doc.id)
    expect(canonicalElements(scene())).toBe(
      canonicalElements(
        ((copy[0]?.scene as { elements?: unknown[] } | undefined)?.elements ??
          []),
      ),
    )

    const copiedPage = await duplicatePage(owner.user.id, doc.id)
    const copiedIds = diagramIds(copiedPage.body)
    expect(copiedIds).toHaveLength(2)
    expect(copiedIds.some((id) => ids.includes(id))).toBe(false)

    const foreign = await savePage(owner.user.id, {
      pageId: other.id,
      title: 'Other page',
      body: {
        type: 'doc',
        content: [{ type: 'diagram', attrs: { drawingId: created.id } }],
      },
    })
    const foreignIds = diagramIds(foreign.body)
    expect(foreignIds[0]).not.toBe(created.id)
    const link = drawingLink(created.id)
    expect(tiptapToMarkdown(stored.body)).toContain(link)
    expect(markdownToTiptap(link)).toMatchObject({
      content: [{ type: 'diagram', attrs: { drawingId: created.id } }],
    })

    const read = await mcp(token.token, 'get_page', { page_id: doc.id })
    expect(read.data.body).toContain(`atlas://drawing/${created.id}`)
    const updated = await mcp(token.token, 'update_page', {
      page_id: doc.id,
      body: read.data.body,
      updated_at: read.data.updated_at,
    })
    expect(updated.status).toBe(200)
    expect(updated.data.body).toContain(created.id)
    const removed = await mcp(token.token, 'update_page', {
      page_id: doc.id,
      body: 'Just text',
      updated_at: updated.data.updated_at,
    })
    expect(removed.data.body ?? '').not.toContain(created.id)
    const row = await getDb()
      .select()
      .from(drawing)
      .where(eq(drawing.id, created.id))
    expect(row).toHaveLength(1)

    const hits = await searchVisiblePages(owner.user.id, LABEL)
    expect(hits.some((hit) => hit.id === other.id || hit.id === copiedPage.id)).toBe(true)
    const secretHits = await searchVisiblePages(owner.user.id, SECRET)
    expect(secretHits.some((hit) => hit.id === doc.id)).toBe(false)
    const text = await getDb()
      .select({ bodyText: page.bodyText })
      .from(page)
      .where(eq(page.id, copiedPage.id))
    expect(text[0]?.bodyText ?? '').not.toContain(SECRET)
    expect(text[0]?.bodyText ?? '').toContain(LABEL)

    const missing = await get(owner.user.id ? token.token : '', 'drawingId=missing-drawing')
    const denied = await get(outsiderToken.token, `drawingId=${created.id}`)
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(await missing.text())

    await archivePage(owner.user.id, other.id)
    const archived = await get(token.token, `drawingId=${foreignIds[0]}`)
    expect(archived.status).toBe(404)
    const archivedSearch = await searchVisiblePages(owner.user.id, LABEL)
    expect(archivedSearch.some((hit) => hit.id === other.id)).toBe(false)
    const view = await getPageView(owner.user.id, doc.id).catch(() => null)
    expect(view?.id).toBe(doc.id)
  })
})
