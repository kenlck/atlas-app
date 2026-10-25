import { eq, inArray } from 'drizzle-orm'
import type { Json } from './body-text'
import { emptyDoc } from './body-text'
import { getDb } from './db'
import { HttpError } from './http'
import { markdownToTiptap, tiptapToMarkdown } from './markdown-body'
import {
  createPageForToken,
  getPageView,
  movePage,
  updatePageForToken,
} from './pages'
import { page, space } from './schema'
import { listMySpaces } from './teams'
import { authenticateBearer } from './api-tokens'

type ToolName = 'list_spaces' | 'read_page' | 'create_page' | 'update_page'

const TOOLS: Array<{ name: ToolName; description: string; inputSchema: Json }> =
  [
    {
      name: 'list_spaces',
      description: 'List the personal and team spaces this token can access.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'read_page',
      description: 'Read one page as Markdown.',
      inputSchema: {
        type: 'object',
        properties: { page_id: { type: 'string' } },
        required: ['page_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'create_page',
      description: 'Create a page in a space, optionally under a parent page.',
      inputSchema: {
        type: 'object',
        properties: {
          space_id: { type: 'string' },
          parent_id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['space_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_page',
      description:
        'Update a page title or Markdown body. Pass the updated_at from the last read.',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string' },
          parent_id: { type: ['string', 'null'] },
          title: { type: 'string' },
          body: { type: 'string' },
          updated_at: { type: 'string' },
        },
        required: ['page_id'],
        additionalProperties: false,
      },
    },
  ]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

function rpc(id: unknown, result: unknown, status = 200) {
  return json({ jsonrpc: '2.0', id, result }, status)
}

function rpcError(id: unknown, status: number, message: string) {
  const code =
    status === 404
      ? -32004
      : status === 409
        ? -32009
        : status === 403
          ? -32003
          : -32602
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status)
}

function argsOf(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  const record = params as Record<string, unknown>
  const args = record.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
  return args as Record<string, unknown>
}

function stringArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

async function pagePayload(userId: string, pageId: string) {
  const view = await getPageView(userId, pageId)
  return {
    id: view.id,
    space_id: view.spaceId,
    parent_id: view.parentId,
    title: view.title,
    body: tiptapToMarkdown(view.body),
    updated_at: view.updatedAt,
  }
}

async function listSpaces(userId: string) {
  const spaces = await listMySpaces(userId)
  const ids = spaces.map((item) => item.id)
  const teams = new Map<string, string | null>()
  if (ids.length) {
    const rows = await getDb()
      .select({ id: space.id, teamId: space.teamId })
      .from(space)
      .where(inArray(space.id, ids))
    for (const row of rows) teams.set(row.id, row.teamId)
  }
  return {
    spaces: spaces.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      role: item.role,
      team_id: teams.get(item.id) ?? null,
    })),
  }
}

async function callTool(
  userId: string,
  tokenId: string,
  name: string,
  args: Record<string, unknown>,
) {
  if (name === 'list_spaces') return listSpaces(userId)
  if (name === 'read_page') {
    const pageId = stringArg(args, 'page_id')
    if (!pageId) throw new HttpError(400, 'Bad request')
    return pagePayload(userId, pageId)
  }
  if (name === 'create_page') {
    const spaceId = stringArg(args, 'space_id')
    if (!spaceId) throw new HttpError(400, 'Bad request')
    const parent = args.parent_id
    if (parent !== undefined && typeof parent !== 'string') {
      throw new HttpError(400, 'Bad request')
    }
    const title = stringArg(args, 'title')
    const body = args.body
    if (body !== undefined && typeof body !== 'string')
      throw new HttpError(400, 'Bad request')
    const created = await createPageForToken(userId, tokenId, {
      spaceId,
      parentId: parent ?? null,
      title,
      body:
        typeof body === 'string' ? markdownToTiptap(body) : (emptyDoc as Json),
    })
    return pagePayload(userId, created.id)
  }
  if (name === 'update_page') {
    const pageId = stringArg(args, 'page_id')
    if (!pageId) throw new HttpError(400, 'Bad request')
    const hasParent = Object.prototype.hasOwnProperty.call(args, 'parent_id')
    const parent = args.parent_id
    if (hasParent && parent !== null && typeof parent !== 'string') {
      throw new HttpError(400, 'Bad request')
    }
    const hasTitle = args.title !== undefined
    const hasBody = args.body !== undefined
    if (hasTitle && typeof args.title !== 'string') {
      throw new HttpError(400, 'Bad request')
    }
    if (hasBody && typeof args.body !== 'string') {
      throw new HttpError(400, 'Bad request')
    }
    if (!hasParent && !hasTitle && !hasBody) {
      throw new HttpError(400, 'Bad request')
    }
    let updatedAt = typeof args.updated_at === 'string' ? args.updated_at : ''
    if (hasParent) {
      const moved = await movePage(userId, {
        pageId,
        parentId: typeof parent === 'string' ? parent : null,
      })
      updatedAt = moved.updatedAt
      await getDb()
        .update(page)
        .set({ updatedViaTokenId: tokenId })
        .where(eq(page.id, pageId))
    }
    if (!hasTitle && !hasBody) return pagePayload(userId, pageId)
    if (!updatedAt) throw new HttpError(409, 'Conflict')
    const updated = await updatePageForToken(userId, tokenId, {
      pageId,
      title: stringArg(args, 'title'),
      body:
        typeof args.body === 'string' ? markdownToTiptap(args.body) : undefined,
      updatedAt,
    })
    return pagePayload(userId, updated.id)
  }
  throw new HttpError(400, 'Bad request')
}

export async function handleMcp(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticateBearer>>
  try {
    auth = await authenticateBearer(request.headers.get('authorization'))
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status)
    return json({ error: 'Unauthorized' }, 401)
  }

  let message: unknown
  try {
    message = await request.json()
  } catch {
    return json({ error: 'Bad request' }, 400)
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return json({ error: 'Bad request' }, 400)
  }
  const record = message as Record<string, unknown>
  const hasId = Object.prototype.hasOwnProperty.call(record, 'id')
  const id = record.id ?? null
  const method = record.method
  if (typeof method !== 'string') return json({ error: 'Bad request' }, 400)
  if (!hasId) return new Response(null, { status: 202 })

  try {
    if (method === 'initialize') {
      const params = record.params
      const requested =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>).protocolVersion
          : null
      const protocolVersion =
        requested === '2024-11-05' ||
        requested === '2025-03-26' ||
        requested === '2025-06-18'
          ? requested
          : '2025-03-26'
      return rpc(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'atlas', version: '1.0.0' },
      })
    }
    if (method === 'ping') return rpc(id, {})
    if (method === 'tools/list') return rpc(id, { tools: TOOLS })
    if (method === 'tools/call') {
      const params = record.params
      const name =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>).name
          : null
      if (typeof name !== 'string') return rpcError(id, 400, 'Bad request')
      const result = await callTool(
        auth.userId,
        auth.tokenId,
        name,
        argsOf(params),
      )
      return rpc(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      })
    }
    return json(
      {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      },
      200,
    )
  } catch (error) {
    if (error instanceof HttpError)
      return rpcError(id, error.status, error.message)
    return json({ error: 'Internal Server Error' }, 500)
  }
}
