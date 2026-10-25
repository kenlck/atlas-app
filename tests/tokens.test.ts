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
  it('stores a hash, shows the token once, and rejects revoked, expired, and unknown bearers', async () => {
    const person = await createUser('Token Owner')
    const created = await createApiToken(person.user.id, {
      name: 'Laptop',
      scope: 'read_write',
      expiresIn: 'never',
    })
    expect(created.token.startsWith('atl_')).toBe(true)
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
      'get_page',
      'create_page',
      'update_page',
    ])

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

    const fresh = await createApiToken(person.user.id, {
      name: 'Short',
      expiresIn: '30d',
    })
    await getDb()
      .update(apiToken)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiToken.id, fresh.id))
    const expired = await mcp(fresh.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({ error: 'Unauthorized' })
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
      expiresIn: 'never',
    })
    const otherToken = await createApiToken(other.user.id, {
      name: 'other',
      scope: 'read_write',
      expiresIn: 'never',
    })
    const readToken = await createApiToken(owner.user.id, {
      name: 'read',
      scope: 'read',
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

    const before = await getDb()
      .select()
      .from(page)
      .where(eq(page.spaceId, owner.space.id))
    const blocked = await call(readToken.token, 'create_page', {
      space_id: owner.space.id,
      title: 'Nope',
    })
    expect(blocked.status).toBe(403)
    const after = await getDb()
      .select()
      .from(page)
      .where(eq(page.spaceId, owner.space.id))
    expect(after).toHaveLength(before.length)

    const blockedUpdate = await call(readToken.token, 'update_page', {
      page_id: note.id,
      title: 'Changed',
      updated_at: payload.updated_at,
    })
    expect(blockedUpdate.status).toBe(403)
    expect((await getPageView(owner.user.id, note.id)).title).toBe('Secret')

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
    const token = await createApiToken(member.user.id, {
      name: 'member',
      scope: 'read',
    })
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
    const created = await createApiToken(person.user.id, {
      name: 'agent',
      expiresIn: 'never',
    })
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

    const pending = await createApiToken(person.user.id, {
      name: 'later',
      expiresIn: 'never',
    })
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
})
