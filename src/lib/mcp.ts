import { inArray } from 'drizzle-orm'
import type { Json } from './body-text'
import { emptyDoc } from './body-text'
import { getDb } from './db'
import { HttpError } from './http'
import { markdownToTiptap, tiptapToMarkdown } from './markdown-body'
import {
  MCP_MAX_BODY_BYTES,
  allowMcpRequest,
} from './mcp-limit'
import { createPageForToken, getPageView, updatePageForToken } from './pages'
import { space } from './schema'
import { listMySpaces } from './teams'
import { authenticateBearer, recordTokenUse } from './api-tokens'
import type { TokenScope } from './api-tokens'

type ToolName = 'list_spaces' | 'get_page' | 'create_page' | 'update_page'

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const READ_TOOLS = new Set(['list_spaces', 'search_pages', 'get_page'])

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
      name: 'get_page',
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
          title: { type: 'string' },
          body: { type: 'string' },
          updated_at: { type: 'string' },
        },
        required: ['page_id', 'updated_at'],
        additionalProperties: false,
      },
    },
  ]

function json(body: unknown, status = 200, extra?: Record<string, string>) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...extra,
  }
  if (status === 401) headers['www-authenticate'] = 'Bearer realm="mcp"'
  return new Response(JSON.stringify(body), { status, headers })
}

function respond(mode: 'json' | 'sse', body: unknown, status = 200) {
  if (mode === 'sse') {
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      status,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      },
    })
  }
  return json(body, status)
}

function rpc(mode: 'json' | 'sse', id: unknown, result: unknown, status = 200) {
  return respond(mode, { jsonrpc: '2.0', id, result }, status)
}

function rpcError(
  mode: 'json' | 'sse',
  id: unknown,
  status: number,
  message: string,
) {
  const code =
    status === 404
      ? -32004
      : status === 409
        ? -32009
        : status === 403
          ? -32003
          : -32602
  return respond(mode, { jsonrpc: '2.0', id, error: { code, message } }, status)
}

function responseMode(request: Request): 'json' | 'sse' | 'reject' {
  const header = request.headers.get('accept')
  if (!header) return 'json'
  const types = header
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase())
    .filter((part): part is string => Boolean(part))
  if (types.includes('*/*') || types.includes('application/json')) return 'json'
  if (types.includes('text/event-stream')) return 'sse'
  return 'reject'
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

function assertScope(scope: TokenScope, name: string) {
  if (scope === 'read' && !READ_TOOLS.has(name)) {
    throw new HttpError(403, 'Forbidden')
  }
}

async function callTool(
  userId: string,
  tokenId: string,
  scope: TokenScope,
  name: string,
  args: Record<string, unknown>,
) {
  assertScope(scope, name)
  if (name === 'list_spaces') return listSpaces(userId)
  if (name === 'get_page') {
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
      body: typeof body === 'string' ? markdownToTiptap(body) : emptyDoc,
    })
    return pagePayload(userId, created.id)
  }
  if (name === 'update_page') {
    if (Object.prototype.hasOwnProperty.call(args, 'parent_id')) {
      throw new HttpError(400, 'Bad request')
    }
    const pageId = stringArg(args, 'page_id')
    if (!pageId) throw new HttpError(400, 'Bad request')
    if (args.title !== undefined && typeof args.title !== 'string') {
      throw new HttpError(400, 'Bad request')
    }
    if (args.body !== undefined && typeof args.body !== 'string') {
      throw new HttpError(400, 'Bad request')
    }
    if (args.title === undefined && args.body === undefined) {
      throw new HttpError(400, 'Bad request')
    }
    const updated = await updatePageForToken(userId, tokenId, {
      pageId,
      title: stringArg(args, 'title'),
      body:
        typeof args.body === 'string' ? markdownToTiptap(args.body) : undefined,
      updatedAt: args.updated_at,
    })
    return pagePayload(userId, updated.id)
  }
  throw new HttpError(400, 'Bad request')
}

async function readLimitedBody(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isFinite(size) || size < 0 || size > MCP_MAX_BODY_BYTES) {
      return null
    }
  }
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let next = await reader.read()
  while (!next.done) {
    total += next.value.byteLength
    if (total > MCP_MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(next.value)
    next = await reader.read()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function handleMcp(request: Request) {
  if (request.method !== 'POST') {
    return new Response(null, {
      status: 405,
      headers: { allow: 'POST' },
    })
  }

  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MCP_MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined)
    return json({ error: 'Payload too large' }, 413)
  }
  const raw = await readLimitedBody(request)
  if (!raw) return json({ error: 'Payload too large' }, 413)

  let auth: Awaited<ReturnType<typeof authenticateBearer>>
  try {
    auth = await authenticateBearer(request.headers.get('authorization'))
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status)
    return json({ error: 'Unauthorized' }, 401)
  }

  if (!allowMcpRequest(auth.tokenId)) {
    return json({ error: 'Too many requests' }, 429, { 'retry-after': '60' })
  }
  await recordTokenUse(auth.tokenId)

  const mode = responseMode(request)
  if (mode === 'reject') return json({ error: 'Not acceptable' }, 406)

  const version = request.headers.get('mcp-protocol-version')
  if (version && !PROTOCOL_VERSIONS.includes(version)) {
    return json({ error: 'Bad request' }, 400)
  }

  let message: unknown
  try {
    message = JSON.parse(new TextDecoder().decode(raw))
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
      const protocolVersion = PROTOCOL_VERSIONS.includes(String(requested))
        ? requested
        : '2025-03-26'
      return rpc(mode, id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'atlas', version: '1.0.0' },
      })
    }
    if (method === 'ping') return rpc(mode, id, {})
    if (method === 'tools/list') return rpc(mode, id, { tools: TOOLS })
    if (method === 'tools/call') {
      const params = record.params
      const name =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>).name
          : null
      if (typeof name !== 'string') return rpcError(mode, id, 400, 'Bad request')
      const result = await callTool(
        auth.userId,
        auth.tokenId,
        auth.scope,
        name,
        argsOf(params),
      )
      return rpc(mode, id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      })
    }
    return respond(
      mode,
      {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      },
      200,
    )
  } catch (error) {
    if (error instanceof HttpError)
      return rpcError(mode, id, error.status, error.message)
    return json({ error: 'Internal Server Error' }, 500)
  }
}
