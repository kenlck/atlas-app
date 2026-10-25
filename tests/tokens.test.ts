import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  handleResetPassword,
  resetAdminRateLimit,
} from '../src/lib/admin-reset'
import {
  authenticateBearer,
  createApiToken,
  listApiTokens,
} from '../src/lib/api-tokens'
import type { Json } from '../src/lib/body-text'
import { getDb } from '../src/lib/db'
import { HttpError } from '../src/lib/http'
import { tiptapToMarkdown } from '../src/lib/markdown-body'
import { handleMcp } from '../src/lib/mcp'
import {
  MCP_MAX_BODY_BYTES,
  MCP_RATE_MAX,
  resetMcpRateLimit,
} from '../src/lib/mcp-limit'
import { setNewPassword } from '../src/lib/password'
import { createPage, getPageView, savePage } from '../src/lib/pages'
import { apiToken, page, user } from '../src/lib/schema'
import {
  acceptInvite,
  createInvite,
  createTeam,
  removeMember,
} from '../src/lib/teams'
import { createUser } from './helpers'

const SECRET = 'test-admin-api-secret-32-chars-minx'

function mcp(token: string | null, body: unknown) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  return handleMcp(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
}

function call(
  token: string | null,
  name: string,
  args: Record<string, unknown>,
) {
  return mcp(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
}

async function toolJson(response: Response) {
  const payload = (await response.json()) as {
    result?: { content?: Array<{ text?: string }> }
    error?: { message?: string }
  }
  const text = payload.result?.content?.[0]?.text
  return text ? (JSON.parse(text) as Record<string, unknown>) : payload
}

const richDoc: Json = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Meet ' },
        { type: 'mention', attrs: { id: 'user-1', label: 'Ada' } },
        { type: 'text', text: ' on ' },
        { type: 'dateChip', attrs: { date: '2026-10-23' } },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Who' }] },
              ],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: [80], align: null },
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'mention', attrs: { id: 'user-1', label: 'Ada' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

describe('api tokens', () => {
  it('stores a hash, shows the token once, and rejects revoked and unknown bearers', async () => {
    const person = await createUser('Token Owner')
    const created = await createApiToken(person.user.id, { name: 'Laptop' })
    expect(created.token.startsWith('atl_')).toBe(true)
    expect(created.scope).toBe('read')
    const expiresIn = Date.parse(created.expiresAt ?? '') - Date.now()
    expect(expiresIn).toBeGreaterThan(89 * 24 * 60 * 60 * 1000)
    expect(expiresIn).toBeLessThan(91 * 24 * 60 * 60 * 1000)
    expect(created.prefix).toBe(created.token.slice(0, 8))
    expect(created.token.length).toBeGreaterThan(created.prefix.length)

    const rows = await getDb()
      .select()
      .from(apiToken)
      .where(eq(apiToken.userId, person.user.id))
    const stored = JSON.stringify(rows)
    expect(stored.includes(created.token)).toBe(false)
    expect(rows[0]?.tokenHash).toBe(
      createHash('sha256').update(created.token).digest('hex'),
    )
    expect(rows[0]?.tokenHash).not.toBe(created.token)

    const listed = await listApiTokens(person.user.id)
    expect(JSON.stringify(listed).includes(created.token)).toBe(false)
    expect(listed[0]?.prefix).toBe(created.prefix)
    expect(listed[0]?.lastUsedAt).toBeNull()

    const missing = await mcp(null, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    const garbage = await mcp('not-a-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(missing.status).toBe(401)
    expect(garbage.status).toBe(401)
    expect(await missing.json()).toEqual(await garbage.json())
    expect(
      JSON.stringify(
        await mcp('atl_nope', { jsonrpc: '2.0', id: 1, method: 'ping' }).then(
          (res) => res.json(),
        ),
      ),
    ).not.toMatch(/exist|revok|expir/i)

    const live = await mcp(created.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(live.status).toBe(200)
    const tools = (await live.json()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(tools.result.tools.map((tool) => tool.name)).toEqual([
      'list_spaces',
      'search_pages',
      'get_page',
      'create_page',
      'update_page',
    ])
    const used = await listApiTokens(person.user.id)
    expect(used[0]?.lastUsedAt).toEqual(expect.any(String))

    await getDb()
      .update(apiToken)
      .set({ revokedAt: new Date() })
      .where(eq(apiToken.id, created.id))
    const revoked = await mcp(created.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toEqual({ error: 'Unauthorized' })
  })

  it('scopes bearer reads and writes to the token owner', async () => {
    const owner = await createUser('Owner')
    const other = await createUser('Other')
    const note = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Secret',
    })
    await savePage(owner.user.id, {
      pageId: note.id,
      title: 'Secret',
      body: richDoc,
    })
    const ownerToken = await createApiToken(owner.user.id, {
      name: 'owner',
      scope: 'read_write',
    })
    const otherToken = await createApiToken(other.user.id, {
      name: 'other',
      scope: 'read_write',
    })

    const denied = await call(otherToken.token, 'get_page', {
      page_id: note.id,
    })
    expect(denied.status).toBe(404)
    expect(
      (await denied.json()) as { error: { message: string } },
    ).toMatchObject({
      error: { message: 'Not found' },
    })

    const read = await call(ownerToken.token, 'get_page', { page_id: note.id })
    expect(read.status).toBe(200)
    const payload = await toolJson(read)
    expect(payload.title).toBe('Secret')
    expect(payload.body).toBe(tiptapToMarkdown(richDoc))

    const deniedWrite = await call(otherToken.token, 'create_page', {
      space_id: owner.space.id,
      title: 'Nope',
    })
    expect(deniedWrite.status).toBe(404)
    const deniedUpdate = await call(otherToken.token, 'update_page', {
      page_id: note.id,
      title: 'Nope',
      updated_at: payload.updated_at,
    })
    expect(deniedUpdate.status).toBe(404)
    expect((await getPageView(owner.user.id, note.id)).title).toBe('Secret')

    const child = await call(ownerToken.token, 'create_page', {
      space_id: owner.space.id,
      parent_id: note.id,
      title: 'Child',
    })
    expect(child.status).toBe(200)
    const childPage = await toolJson(child)
    const childRow = await getDb()
      .select()
      .from(page)
      .where(eq(page.id, String(childPage.id)))
    expect(childRow[0]?.updatedViaTokenId).toBe(ownerToken.id)
    const beforeMove = await getPageView(owner.user.id, note.id)
    const rejectedParent = await call(ownerToken.token, 'update_page', {
      page_id: note.id,
      parent_id: childPage.id,
      title: 'Moved',
      updated_at: beforeMove.updatedAt,
    })
    expect(rejectedParent.status).toBe(400)
    const afterReject = await getPageView(owner.user.id, note.id)
    expect(afterReject.parentId).toBeNull()
    expect(afterReject.title).toBe('Secret')
    expect(afterReject.updatedAt).toBe(beforeMove.updatedAt)

    const current = await getPageView(owner.user.id, note.id)
    const stale = await call(ownerToken.token, 'update_page', {
      page_id: note.id,
      title: 'Overwrite',
      updated_at: new Date(
        Date.parse(String(current.updatedAt)) - 1000,
      ).toISOString(),
    })
    expect(stale.status).toBe(409)
    expect((await getPageView(owner.user.id, note.id)).title).toBe('Secret')

    const missingStamp = await call(ownerToken.token, 'update_page', {
      page_id: note.id,
      body: 'changed',
    })
    expect(missingStamp.status).toBe(409)
    expect((await getPageView(owner.user.id, note.id)).body).toEqual(richDoc)

    const same = await call(ownerToken.token, 'update_page', {
      page_id: note.id,
      title: 'Secret',
      body: String(payload.body),
      updated_at: current.updatedAt,
    })
    expect(same.status).toBe(200)
    const saved = await getPageView(owner.user.id, note.id)
    expect(saved.body).toEqual(richDoc)
    const row = await getDb().select().from(page).where(eq(page.id, note.id))
    expect(row[0]?.updatedViaTokenId).toBe(ownerToken.id)
  })

  it('stops reaching a team page after the owner is removed', async () => {
    const owner = await createUser('Owner')
    const member = await createUser('Member')
    const team = await createTeam(owner.user.id, 'North')
    const invite = await createInvite(owner.user.id, team.id, member.user.id)
    await acceptInvite(member.user.id, invite.id)
    const note = await createPage(owner.user.id, {
      spaceId: team.spaceId,
      title: 'Shared',
    })
    const token = await createApiToken(member.user.id, { name: 'member' })
    expect(
      (await call(token.token, 'get_page', { page_id: note.id })).status,
    ).toBe(200)
    await removeMember(owner.user.id, team.id, member.user.id)
    expect(
      (await call(token.token, 'get_page', { page_id: note.id })).status,
    ).toBe(404)
  })

  it('revokes every token when an admin resets the password', async () => {
    process.env.ADMIN_API_SECRET = SECRET
    resetAdminRateLimit()
    const person = await createUser('Reset')
    const created = await createApiToken(person.user.id, { name: 'agent' })
    const response = await handleResetPassword(
      new Request('http://127.0.0.1:3000/api/admin/reset-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify({ email: person.user.email }),
      }),
      '203.0.113.50',
    )
    expect(response.status).toBe(200)
    const locked = await mcp(created.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(locked.status).toBe(401)
    await setNewPassword(person.user.id, 'replacement-password')
    const afterwards = await mcp(created.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(afterwards.status).toBe(401)

    const pending = await createApiToken(person.user.id, { name: 'later' })
    await getDb()
      .update(user)
      .set({ mustChangePassword: true })
      .where(eq(user.id, person.user.id))
    await expect(
      authenticateBearer(`Bearer ${pending.token}`),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Password change required',
    } satisfies Partial<HttpError>)
  })

  it('rejects parent_id and a missing or stale updated_at before any write', async () => {
    const owner = await createUser('Revo')
    const note = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Note',
    })
    await savePage(owner.user.id, {
      pageId: note.id,
      title: 'Note',
      body: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'human edit v2' }] },
        ],
      },
    })
    const token = await createApiToken(owner.user.id, {
      name: 'agent',
      scope: 'read_write',
    })
    const other = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Other',
    })
    const before = await getPageView(owner.user.id, note.id)

    const missing = await call(token.token, 'update_page', {
      page_id: note.id,
      body: 'agent clobber',
    })
    expect(missing.status).toBe(409)
    expect((await getPageView(owner.user.id, note.id)).body).toEqual(before.body)
    expect((await getPageView(owner.user.id, note.id)).updatedAt).toBe(
      before.updatedAt,
    )

    const bypass = await call(token.token, 'update_page', {
      page_id: note.id,
      parent_id: null,
      body: 'agent clobber',
    })
    expect(bypass.status).toBe(400)
    expect((await getPageView(owner.user.id, note.id)).updatedAt).toBe(
      before.updatedAt,
    )

    await savePage(owner.user.id, {
      pageId: note.id,
      title: 'Note',
      body: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'human edit v3' }] },
        ],
      },
    })
    const saved = await getPageView(owner.user.id, note.id)
    const stale = await call(token.token, 'update_page', {
      page_id: note.id,
      parent_id: null,
      title: 'Agent title',
      body: 'agent clobber 2',
      updated_at: '2000-01-01T00:00:00.000Z',
    })
    expect(stale.status).toBe(400)
    const afterStale = await getPageView(owner.user.id, note.id)
    expect(afterStale.title).toBe('Note')
    expect(afterStale.body).toEqual(saved.body)
    expect(afterStale.updatedAt).toBe(saved.updatedAt)

    const moved = await call(token.token, 'update_page', {
      page_id: note.id,
      parent_id: other.id,
      updated_at: saved.updatedAt,
    })
    expect(moved.status).toBe(400)
    expect((await getPageView(owner.user.id, note.id)).parentId).toBeNull()
  })

  it('refuses writes from a read token and 401s an expired token', async () => {
    const owner = await createUser('Scoped')
    const note = await createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Kept',
    })
    const reader = await createApiToken(owner.user.id, {
      name: 'reader',
      scope: 'read',
      expiry: '30d',
    })
    const writer = await createApiToken(owner.user.id, {
      name: 'writer',
      scope: 'read_write',
      expiry: 'never',
    })
    expect(writer.expiresAt).toBeNull()
    const deniedCreate = await call(reader.token, 'create_page', {
      space_id: owner.space.id,
      title: 'Nope',
    })
    expect(deniedCreate.status).toBe(403)
    const read = await call(reader.token, 'get_page', { page_id: note.id })
    expect(read.status).toBe(200)
    const payload = await toolJson(read)
    const deniedUpdate = await call(reader.token, 'update_page', {
      page_id: note.id,
      title: 'Nope',
      updated_at: payload.updated_at,
    })
    expect(deniedUpdate.status).toBe(403)
    expect((await getPageView(owner.user.id, note.id)).title).toBe('Kept')

    await getDb()
      .update(apiToken)
      .set({ expiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(apiToken.id, reader.id))
    const expired = await mcp(reader.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    const missing = await mcp(null, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual(await missing.json())
    expect(expired.headers.get('www-authenticate')).toBe('Bearer realm="mcp"')
    expect(missing.headers.get('www-authenticate')).toBe(
      expired.headers.get('www-authenticate'),
    )
  })

  it('searches only pages the token can access', async () => {
    const owner = await createUser('SearchOwner')
    const other = await createUser('SearchOther')
    const team = await createTeam(owner.user.id, 'Hidden search')
    const hidden = await createPage(owner.user.id, {
      spaceId: team.spaceId,
      title: 'TeamOnlyMarker',
    })
    const mine = await createPage(other.user.id, {
      spaceId: other.space.id,
      title: 'MineMarker',
    })
    const reader = await createApiToken(other.user.id, {
      name: 'reader',
      scope: 'read',
    })
    const writer = await createApiToken(other.user.id, {
      name: 'writer',
      scope: 'read_write',
    })
    const hiddenRead = await call(reader.token, 'search_pages', {
      query: 'TeamOnlyMarker',
    })
    const hiddenWrite = await call(writer.token, 'search_pages', {
      query: 'TeamOnlyMarker',
    })
    const ownRead = await call(reader.token, 'search_pages', {
      query: 'MineMarker',
    })
    const ownWrite = await call(writer.token, 'search_pages', {
      query: 'MineMarker',
    })
    expect(hiddenRead.status).toBe(200)
    expect(hiddenWrite.status).toBe(200)
    expect(ownRead.status).toBe(200)
    expect(ownWrite.status).toBe(200)
    const ids = async (response: Response) => {
      const payload = (await toolJson(response)) as { hits?: Array<{ id?: string }> }
      return (payload.hits ?? []).map((hit) => hit.id)
    }
    expect(await ids(hiddenRead)).not.toContain(hidden.id)
    expect(await ids(hiddenWrite)).not.toContain(hidden.id)
    expect(await ids(ownRead)).toContain(mine.id)
    expect(await ids(ownWrite)).toContain(mine.id)
  })

  it('rate limits a token and refuses a body over 1 MiB', async () => {
    resetMcpRateLimit()
    const owner = await createUser('Limited')
    const token = await createApiToken(owner.user.id, {
      name: 'limited',
      scope: 'read_write',
    })
    for (let i = 0; i < MCP_RATE_MAX; i += 1) {
      const ok = await mcp(token.token, { jsonrpc: '2.0', id: i, method: 'ping' })
      expect(ok.status).toBe(200)
    }
    const blocked = await mcp(token.token, {
      jsonrpc: '2.0',
      id: 99,
      method: 'ping',
    })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'Too many requests' })

    const huge = 'x'.repeat(MCP_MAX_BODY_BYTES)
    const oversized = await handleMcp(
      new Request('http://127.0.0.1:3000/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'create_page',
            arguments: {
              space_id: owner.space.id,
              title: 'Huge page',
              body: huge,
            },
          },
        }),
      }),
    )
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'Payload too large' })
    const stored = await getDb()
      .select()
      .from(page)
      .where(eq(page.title, 'Huge page'))
    expect(stored).toHaveLength(0)
  })

  it('answers streamable HTTP GET with 405 and SSE when that is the only accept type', async () => {
    const owner = await createUser('Stream')
    const token = await createApiToken(owner.user.id, { name: 'stream' })
    const get = await handleMcp(
      new Request('http://127.0.0.1:3000/mcp', { method: 'GET' }),
    )
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')

    const sse = await handleMcp(
      new Request('http://127.0.0.1:3000/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${token.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
    )
    expect(sse.status).toBe(200)
    expect(sse.headers.get('content-type')).toBe('text/event-stream')
    expect(await sse.text()).toContain('"result":{}')

    const rejected = await handleMcp(
      new Request('http://127.0.0.1:3000/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/html',
          authorization: `Bearer ${token.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
    )
    expect(rejected.status).toBe(406)
  })
})
