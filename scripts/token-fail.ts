import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import { MCP_MAX_BODY_BYTES, MCP_RATE_MAX } from '../src/lib/mcp-limit'
import { postgresPoolOptions } from '../src/lib/postgres-options'
import { assertLocalBaseUrl, assertLocalDatabaseUrl } from './verify-local.ts'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function databaseUrl() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) fail('DATABASE_URL or TEST_DATABASE_URL is required')
  try {
    assertLocalDatabaseUrl(url)
  } catch {
    console.error('refusing non-local DATABASE_URL')
    process.exit(2)
  }
  return url
}

function baseUrl() {
  if (!process.env.BASE_URL) fail('BASE_URL is required')
  return assertLocalBaseUrl(process.env.BASE_URL)
}

function redact(text: string) {
  if (text.includes('atl_')) return 'response_withheld'
  return text
    .replace(
      /better-auth\.session_token=[^;\s]+/g,
      'better-auth.session_token=[redacted]',
    )
    .replace(/("token"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("password"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, 240)
}

function cookieHeader(response: Response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []
  return raw
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry.includes('='))
    .join('; ')
}

async function signUp(base: string, name: string) {
  const email = `${name}.${crypto.randomUUID()}@example.com`.toLowerCase()
  const password = `pw-${crypto.randomUUID()}`
  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name, email, password }),
    })
    if (response.status !== 429) break
    const retryAfter = Number(response.headers.get('x-retry-after') ?? '10')
    const seconds = Math.min(
      15,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter + 1 : 11,
    )
    console.log(`signup_status=429 retry_after=${seconds}`)
    await response.text().catch(() => '')
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }
  if (!response) fail('sign-up missing response')
  const text = await response.text()
  console.log(`signup_status=${response.status}`)
  if (response.status !== 200) fail(redact(text))
  const cookie = cookieHeader(response)
  if (!cookie) fail('signup_cookie=missing')
  const body = JSON.parse(text) as { user?: { id?: string } }
  if (!body.user?.id) fail('signup_user=missing')
  return { cookie, email, userId: body.user.id }
}

async function createToken(
  base: string,
  cookie: string,
  name: string,
  options?: {
    scope?: 'read' | 'read_write'
    expiry?: '30d' | '90d' | '1y' | 'never'
  },
) {
  const response = await fetch(`${base}/api/atlas/tokens`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name,
      scope: options?.scope ?? 'read_write',
      expiry: options?.expiry ?? '90d',
    }),
  })
  const text = await response.text()
  console.log(`create_status=${response.status}`)
  if (response.status !== 201) fail(redact(text))
  const body = JSON.parse(text) as { id?: string; token?: string }
  if (!body.id || !body.token || !body.token.startsWith('atl_'))
    fail('create_token=missing')
  console.log(`token_len=${body.token.length}`)
  return { id: body.id, token: body.token }
}

async function mcp(base: string, token: string | null, body: unknown) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

function toolText(text: string, secret: string) {
  return text.split(secret).join('[redacted]')
}

async function revoked(base: string) {
  const user = await signUp(base, 'Revoked')
  const created = await createToken(base, user.cookie, 'revoked')
  const before = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  console.log(`before_revoke_status=${before.status}`)
  if (before.status !== 200)
    fail(toolText(before.text, created.token).slice(0, 240))
  const removed = await fetch(`${base}/api/atlas/tokens/${created.id}`, {
    method: 'DELETE',
    headers: { cookie: user.cookie, origin: base },
  })
  console.log(`revoke_status=${removed.status}`)
  await removed.text().catch(() => '')
  if (removed.status !== 200) fail('revoke_failed')
  const after = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })
  console.log(`revoked_status=${after.status}`)
  if (after.status !== 401) fail('revoked_token_was_accepted')
}

async function cross(base: string) {
  const owner = await signUp(base, 'Owner')
  const other = await signUp(base, 'Other')
  const ownerToken = await createToken(base, owner.cookie, 'owner')
  const otherToken = await createToken(base, other.cookie, 'other')
  const spaces = await mcp(base, ownerToken.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_spaces', arguments: {} },
  })
  if (spaces.status !== 200) fail('list_spaces_failed')
  const listed = JSON.parse(spaces.text) as {
    result?: { content?: Array<{ text?: string }> }
  }
  const payload = JSON.parse(listed.result?.content?.[0]?.text ?? '{}') as {
    spaces?: Array<{ id?: string; kind?: string }>
  }
  const personal = payload.spaces?.find((item) => item.kind === 'personal')
  if (!personal?.id) fail('personal_space=missing')
  const created = await mcp(base, ownerToken.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: {
        space_id: personal.id,
        title: 'Private',
        body: 'Only the owner',
      },
    },
  })
  console.log(`owner_create_status=${created.status}`)
  if (created.status !== 200) fail('owner_create_failed')
  const page = JSON.parse(
    (
      JSON.parse(created.text) as {
        result?: { content?: Array<{ text?: string }> }
      }
    ).result?.content?.[0]?.text ?? '{}',
  ) as { id?: string }
  if (!page.id) fail('page_id=missing')
  const ownerRead = await mcp(base, ownerToken.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: page.id } },
  })
  console.log(`owner_status=${ownerRead.status}`)
  const otherRead = await mcp(base, otherToken.token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: page.id } },
  })
  console.log(`cross_user_status=${otherRead.status}`)
  if (ownerRead.status !== 200 || otherRead.status !== 404)
    fail('cross_user_access')
}

function ident(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) fail('bad_identifier')
  return `"${name}"`
}

async function tokenInDatabase(url: string, token: string) {
  const sql = postgres(url, postgresPoolOptions(url))
  try {
    const columns = await sql<
      Array<{ table_name: string; column_name: string }>
    >`
      select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name = c.table_name
      where c.table_schema = 'public'
        and t.table_type = 'BASE TABLE'
        and c.data_type in ('text', 'character varying', 'json', 'jsonb')
    `
    console.log(`columns_checked=${columns.length}`)
    if (columns.length === 0) fail('columns_checked=0')
    for (const column of columns) {
      const found = await sql.unsafe(
        `select 1 as hit from ${ident(column.table_name)} where position($1 in ${ident(column.column_name)}::text) > 0 limit 1`,
        [token],
      )
      if (found.length > 0) return true
    }
    return false
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function tokenInLogs(token: string) {
  const container = process.env.ATLAS_CONTAINER
  if (!container) fail('ATLAS_CONTAINER is required')
  const result = spawnSync('docker', ['logs', container], { encoding: 'utf8' })
  if (result.status !== 0) fail('docker_logs_failed')
  const logs = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return logs.includes(token)
}

async function secret(base: string) {
  const url = databaseUrl()
  const user = await signUp(base, 'Secret')
  const created = await createToken(base, user.cookie, 'secret')
  const used = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  console.log(`use_status=${used.status}`)
  if (used.status !== 200) fail('secret_token_rejected')
  const inDb = await tokenInDatabase(url, created.token)
  const inLogs = tokenInLogs(created.token)
  console.log(`token_in_db=${inDb}`)
  console.log(`token_in_logs=${inLogs}`)
  if (inDb || inLogs) fail('raw_token_leaked')
}

async function bearer(base: string) {
  const user = await signUp(base, 'Bearer')
  const created = await createToken(base, user.cookie, 'bearer')
  const live = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  if (live.status !== 200) fail('bearer_token_rejected')
  const removed = await fetch(`${base}/api/atlas/tokens/${created.id}`, {
    method: 'DELETE',
    headers: { cookie: user.cookie, origin: base },
  })
  await removed.text().catch(() => '')
  if (removed.status !== 200) fail('revoke_failed')
  const missing = await mcp(base, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  const garbage = await mcp(base, 'not-a-token', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  const revokedCall = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  const unknown = `atl_${randomBytes(32).toString('base64url')}`
  const unknownCall = await mcp(base, unknown, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  const expiring = await createToken(base, user.cookie, 'expired')
  await expireToken(expiring.id)
  const expiredCall = await mcp(base, expiring.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  console.log(`missing_bearer_status=${missing.status}`)
  console.log(`garbage_bearer_status=${garbage.status}`)
  console.log(`revoked_bearer_status=${revokedCall.status}`)
  console.log(`unknown_bearer_status=${unknownCall.status}`)
  console.log(`expired_bearer_status=${expiredCall.status}`)
  const same =
    missing.text === garbage.text &&
    missing.text === revokedCall.text &&
    missing.text === unknownCall.text &&
    missing.text === expiredCall.text
  console.log(`bearer_bodies_match=${missing.text === garbage.text}`)
  console.log(`bearer_bodies_identical=${same}`)
  const leaks = /exist|revok|expir|invalid token|not found/i.test(missing.text)
  console.log(`bearer_body_leaks_existence=${leaks}`)
  if (
    missing.status !== 401 ||
    garbage.status !== 401 ||
    revokedCall.status !== 401 ||
    unknownCall.status !== 401 ||
    expiredCall.status !== 401 ||
    !same ||
    leaks
  ) {
    fail('bearer_auth')
  }
}

function toolPayload(text: string) {
  const listed = JSON.parse(text) as {
    result?: { content?: Array<{ text?: string }> }
    error?: { message?: string }
  }
  return {
    error: listed.error?.message ?? '',
    data: JSON.parse(listed.result?.content?.[0]?.text ?? '{}') as Record<
      string,
      unknown
    >,
  }
}

async function personalSpace(base: string, token: string) {
  const spaces = await mcp(base, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_spaces', arguments: {} },
  })
  if (spaces.status !== 200) fail('list_spaces_failed')
  const payload = toolPayload(spaces.text).data as {
    spaces?: Array<{ id?: string; kind?: string }>
  }
  const personal = payload.spaces?.find((item) => item.kind === 'personal')
  if (!personal?.id) fail('personal_space=missing')
  return personal.id
}

async function writes(base: string) {
  const owner = await signUp(base, 'Writer')
  const other = await signUp(base, 'Stranger')
  const ownerToken = await createToken(base, owner.cookie, 'writer')
  const otherToken = await createToken(base, other.cookie, 'stranger')
  const spaceId = await personalSpace(base, ownerToken.token)
  const parent = await mcp(base, ownerToken.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Parent', body: 'Parent' },
    },
  })
  if (parent.status !== 200) fail('parent_create_failed')
  const parentPage = toolPayload(parent.text).data
  const deniedCreate = await mcp(base, otherToken.token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Nope' },
    },
  })
  const deniedUpdate = await mcp(base, otherToken.token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'update_page',
      arguments: {
        page_id: parentPage.id,
        title: 'Nope',
        updated_at: parentPage.updated_at,
      },
    },
  })
  console.log(`create_denied_status=${deniedCreate.status}`)
  console.log(`update_denied_status=${deniedUpdate.status}`)
  if (deniedCreate.status !== 404 || deniedUpdate.status !== 404) fail('writes')
}

async function teamRemoval(base: string) {
  const lead = await signUp(base, 'Lead')
  const member = await signUp(base, 'Member')
  const team = await fetch(`${base}/api/atlas/teams`, {
    method: 'POST',
    headers: {
      cookie: lead.cookie,
      origin: base,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'North' }),
  })
  const teamText = await team.text()
  console.log(`team_status=${team.status}`)
  if (team.status !== 201) fail(redact(teamText))
  const createdTeam = JSON.parse(teamText) as { id?: string; spaceId?: string }
  if (!createdTeam.id || !createdTeam.spaceId) fail('team=missing')
  const invite = await fetch(`${base}/api/atlas/teams/${createdTeam.id}/invites`, {
    method: 'POST',
    headers: {
      cookie: lead.cookie,
      origin: base,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ userId: member.userId }),
  })
  const inviteText = await invite.text()
  console.log(`invite_status=${invite.status}`)
  if (invite.status !== 201) fail(redact(inviteText))
  const createdInvite = JSON.parse(inviteText) as { id?: string }
  if (!createdInvite.id) fail('invite=missing')
  const accepted = await fetch(
    `${base}/api/atlas/invites/${createdInvite.id}/accept`,
    {
      method: 'POST',
      headers: { cookie: member.cookie, origin: base },
    },
  )
  console.log(`accept_status=${accepted.status}`)
  await accepted.text().catch(() => '')
  if (accepted.status !== 200) fail('accept_failed')
  const memberToken = await createToken(base, member.cookie, 'member')
  const page = await mcp(base, memberToken.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: {
        space_id: createdTeam.spaceId,
        title: 'Shared',
        body: 'Shared',
      },
    },
  })
  if (page.status !== 200) fail('team_page_failed')
  const pageId = toolPayload(page.text).data.id
  const before = await mcp(base, memberToken.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: pageId } },
  })
  console.log(`before_removal_status=${before.status}`)
  const removed = await fetch(
    `${base}/api/atlas/teams/${createdTeam.id}/members/${member.userId}`,
    { method: 'DELETE', headers: { cookie: lead.cookie, origin: base } },
  )
  console.log(`remove_status=${removed.status}`)
  await removed.text().catch(() => '')
  const after = await mcp(base, memberToken.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: pageId } },
  })
  console.log(`after_removal_status=${after.status}`)
  if (before.status !== 200 || removed.status !== 200 || after.status !== 404) {
    fail('team_removal')
  }
}

async function resetThroughSameImage(email: string, secret: string) {
  const running = process.env.ATLAS_CONTAINER
  if (!running) fail('ATLAS_CONTAINER is required')
  const inspected = spawnSync(
    'docker',
    ['inspect', '-f', '{{.Config.Image}}', running],
    { encoding: 'utf8' },
  )
  if (inspected.status !== 0) fail('image_inspect_failed')
  const image = (inspected.stdout ?? '').trim()
  if (!image.startsWith('atlas-app')) fail('image_unexpected')
  const name = 'atlas-token-reset'
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
  const started = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'host',
      '-e',
      'DATABASE_URL',
      '-e',
      'BETTER_AUTH_SECRET',
      '-e',
      'ADMIN_API_SECRET',
      '-e',
      'BETTER_AUTH_URL=http://127.0.0.1:3001',
      '-e',
      'HOST=127.0.0.1',
      '-e',
      'PORT=3001',
      image,
    ],
    { encoding: 'utf8' },
  )
  if (started.status !== 0) fail('reset_container_failed')
  const origin = 'http://127.0.0.1:3001'
  try {
    let ready = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const ping = await fetch(`${origin}/sign-in`)
        await ping.text().catch(() => '')
        if (ping.ok) {
          ready = true
          break
        }
      } catch {
        // the second process is still booting
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) fail('reset_container_down')
    console.log('reset_image=atlas-app')
    console.log('reset_port=3001')
    return await fetch(`${origin}/api/admin/reset-password`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email }),
    })
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
    console.log('reset_container_removed=true')
  }
}

async function reset(base: string) {
  const secret = process.env.ADMIN_API_SECRET
  if (!secret) fail('ADMIN_API_SECRET is required')
  const user = await signUp(base, 'Reset')
  const created = await createToken(base, user.cookie, 'reset')
  const before = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  console.log(`before_reset_status=${before.status}`)
  const response = await resetThroughSameImage(user.email, secret)
  const resetText = await response.text()
  console.log(`reset_status=${response.status}`)
  if (response.status !== 200) fail('reset_failed')
  const temporary = (JSON.parse(resetText) as { temporaryPassword?: string })
    .temporaryPassword
  if (!temporary) fail('temporary_password=missing')
  const pending = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })
  console.log(`pending_status=${pending.status}`)
  const signedIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: user.email, password: temporary }),
  })
  await signedIn.text()
  console.log(`signin_status=${signedIn.status}`)
  if (signedIn.status !== 200) fail('signin_after_reset')
  const cookie = cookieHeader(signedIn)
  if (!cookie) fail('signin_cookie=missing')
  const next = `pw-${crypto.randomUUID()}`
  const changed = await callServerFn(base, cookie, 'changePasswordFn', {
    password: next,
  })
  console.log(`password_status=${changed.status}`)
  if (changed.status !== 200) fail('password_change_failed')
  const after = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
  })
  console.log(`after_password_status=${after.status}`)
  if (before.status !== 200 || pending.status !== 401 || after.status !== 401) {
    fail('reset_tokens')
  }
}

function serverFnPayload(data: unknown) {
  let next = 0
  const node = (value: unknown): unknown => {
    if (value === null) return { t: 2, s: 0 }
    if (typeof value === 'string') return { t: 1, s: value }
    if (typeof value === 'boolean') return { t: value ? 4 : 3, s: 0 }
    if (Array.isArray(value)) {
      const id = next
      next += 1
      return { t: 9, i: id, a: value.map((item) => node(item)), o: 0 }
    }
    if (typeof value === 'object') {
      const id = next
      next += 1
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
      return {
        t: 10,
        i: id,
        p: { k: keys, v: keys.map((key) => node(record[key])) },
        o: 0,
      }
    }
    throw new Error('unsupported server function value')
  }
  return { t: node(data), f: 127, m: [] as unknown[] }
}

async function serverFnId(name: string) {
  const dir = '.output/server/_ssr'
  const files = (await readdir(dir)).filter(
    (file) => file.startsWith('fns-') && file.endsWith('.mjs'),
  )
  const pattern = new RegExp(
    `var ${name} = createServerFn\\(\\{ method: "(GET|POST)" \\}\\)[\\s\\S]*?createSsrRpc\\("([a-f0-9]{64})"\\)`,
  )
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    const match = pattern.exec(text)
    if (match?.[1] && match[2]) {
      return { id: match[2], method: match[1] as 'GET' | 'POST' }
    }
  }
  fail(`server_fn=${name}`)
}

async function callServerFn(
  base: string,
  cookie: string,
  name: string,
  data: Record<string, unknown>,
) {
  const fn = await serverFnId(name)
  const payload = JSON.stringify(serverFnPayload({ data }))
  const headers: Record<string, string> = {
    cookie,
    origin: base,
    'x-tsr-serverFn': 'true',
  }
  if (fn.method === 'GET') {
    const response = await fetch(
      `${base}/_serverFn/${fn.id}?payload=${encodeURIComponent(payload)}`,
      { headers },
    )
    const text = await response.text()
    return { status: response.status, text }
  }
  headers['content-type'] = 'application/json'
  const response = await fetch(`${base}/_serverFn/${fn.id}`, {
    method: 'POST',
    headers,
    body: payload,
  })
  const text = await response.text()
  return { status: response.status, text }
}

async function roundTrip(base: string) {
  const user = await signUp(base, 'Round')
  const created = await createToken(base, user.cookie, 'round')
  const spaceId = await personalSpace(base, created.token)
  const made = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Draft', body: 'First' },
    },
  })
  console.log(`create_status=${made.status}`)
  if (made.status !== 200) fail('round_create_failed')
  const page = toolPayload(made.text).data
  const read = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: page.id } },
  })
  console.log(`read_status=${read.status}`)
  const updated = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'update_page',
      arguments: {
        page_id: page.id,
        title: 'Published',
        body: 'Second',
        updated_at: page.updated_at,
      },
    },
  })
  console.log(`update_status=${updated.status}`)
  const tree = await callServerFn(base, user.cookie, 'fetchPageTree', {
    spaceId,
  })
  console.log(`list_status=${tree.status}`)
  const viewed = await callServerFn(base, user.cookie, 'fetchPage', {
    pageId: page.id,
  })
  console.log(`app_status=${viewed.status}`)
  const titleMatches =
    viewed.status === 200 &&
    viewed.text.includes('"Published"') &&
    tree.status === 200 &&
    tree.text.includes('"Published"')
  console.log(`app_title_matches=${titleMatches}`)
  const listed = await fetch(`${base}/api/atlas/tokens`, {
    headers: { cookie: user.cookie, origin: base },
  })
  const listedText = await listed.text()
  console.log(`tokens_status=${listed.status}`)
  const tokens = JSON.parse(listedText) as {
    tokens?: Array<{ lastUsedAt?: string | null }>
  }
  const lastUsed = Boolean(tokens.tokens?.some((item) => item.lastUsedAt))
  console.log(`last_used_set=${lastUsed}`)
  if (
    read.status !== 200 ||
    updated.status !== 200 ||
    !titleMatches ||
    !lastUsed
  ) {
    fail('round_trip')
  }
}

async function expireToken(id: string) {
  const sql = postgres(databaseUrl(), postgresPoolOptions(databaseUrl()))
  try {
    await sql`update api_token set expires_at = '2000-01-01T00:00:00.000Z' where id = ${id}`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const richDoc = {
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

async function pageCount(spaceId: string, title: string) {
  const sql = postgres(databaseUrl(), postgresPoolOptions(databaseUrl()))
  try {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from page where space_id = ${spaceId} and title = ${title}
    `
    return rows[0].n
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function fidelity(base: string) {
  const user = await signUp(base, 'Fidelity')
  const created = await createToken(base, user.cookie, 'fidelity')
  const spaceId = await personalSpace(base, created.token)
  const made = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Rich', body: 'placeholder' },
    },
  })
  if (made.status !== 200) fail('fidelity_create_failed')
  const page = toolPayload(made.text).data
  const sql = postgres(databaseUrl(), postgresPoolOptions(databaseUrl()))
  try {
    await sql.unsafe(`update page set body = $1::jsonb where id = $2`, [
      JSON.stringify(richDoc),
      String(page.id),
    ])
    const before = await sql<{ body: string }[]>`
      select body::text as body from page where id = ${page.id as string}
    `
    const read = await mcp(base, created.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_page', arguments: { page_id: page.id } },
    })
    const payload = toolPayload(read.text).data
    const markdown = String(payload.body ?? '')
    const mention = markdown.includes('[@Ada](atlas://user/user-1)')
    const date = markdown.includes('[Oct 23, 2026](atlas://date/2026-10-23)')
    const table = markdown.includes('<table>')
    console.log(`get_status=${read.status}`)
    console.log(`mention_link=${mention}`)
    console.log(`date_link=${date}`)
    console.log(`table_markup=${table}`)
    const updated = await mcp(base, created.token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'update_page',
        arguments: {
          page_id: page.id,
          body: markdown,
          updated_at: payload.updated_at,
        },
      },
    })
    console.log(`update_status=${updated.status}`)
    const after = await sql<{ body: string }[]>`
      select body::text as body from page where id = ${page.id as string}
    `
    const identical = before[0].body === after[0].body && before[0].body.length > 0
    console.log(`stored_body_identical=${identical}`)
    if (
      read.status !== 200 ||
      updated.status !== 200 ||
      !mention ||
      !date ||
      !table ||
      !identical
    ) {
      fail('fidelity')
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function conflict(base: string) {
  const user = await signUp(base, 'Conflict')
  const created = await createToken(base, user.cookie, 'conflict')
  const spaceId = await personalSpace(base, created.token)
  const made = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Original', body: 'Original' },
    },
  })
  if (made.status !== 200) fail('conflict_create_failed')
  const page = toolPayload(made.text).data
  const missing = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'update_page',
      arguments: { page_id: page.id, body: 'agent clobber' },
    },
  })
  const afterMissing = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: page.id } },
  })
  const missingPage = toolPayload(afterMissing.text).data
  const missingUnchanged =
    afterMissing.status === 200 && missingPage.body === 'Original'
  console.log(`missing_status=${missing.status}`)
  console.log(`missing_unchanged=${missingUnchanged}`)
  const stale = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'update_page',
      arguments: {
        page_id: page.id,
        title: 'Agent title',
        body: 'agent clobber 2',
        updated_at: '2000-01-01T00:00:00.000Z',
      },
    },
  })
  const afterStale = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: page.id } },
  })
  const stalePage = toolPayload(afterStale.text).data
  const staleUnchanged =
    afterStale.status === 200 &&
    stalePage.title === 'Original' &&
    stalePage.body === 'Original'
  console.log(`stale_status=${stale.status}`)
  console.log(`stale_unchanged=${staleUnchanged}`)
  const other = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Other', body: 'Other' },
    },
  })
  if (other.status !== 200) fail('conflict_other_failed')
  const otherPage = toolPayload(other.text).data
  const parent = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'update_page',
      arguments: {
        page_id: page.id,
        parent_id: null,
        title: 'Moved',
        body: 'agent clobber',
        updated_at: page.updated_at,
      },
    },
  })
  const reparent = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'update_page',
      arguments: {
        page_id: page.id,
        parent_id: otherPage.id,
        title: 'Moved',
        updated_at: page.updated_at,
      },
    },
  })
  const after = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: page.id } },
  })
  const finalPage = toolPayload(after.text).data
  const unchanged =
    after.status === 200 &&
    finalPage.title === 'Original' &&
    finalPage.body === 'Original' &&
    finalPage.parent_id == null
  console.log(`parent_status=${parent.status}`)
  console.log(`reparent_status=${reparent.status}`)
  console.log(`parent_unchanged=${unchanged}`)
  if (
    missing.status !== 409 ||
    !missingUnchanged ||
    stale.status !== 409 ||
    !staleUnchanged ||
    parent.status !== 400 ||
    reparent.status !== 400 ||
    !unchanged
  ) {
    fail('conflict')
  }
}

async function scopeRead(base: string) {
  const user = await signUp(base, 'Reader')
  const reader = await createToken(base, user.cookie, 'reader', { scope: 'read' })
  const spaceId = await personalSpace(base, reader.token)
  const before = await pageCount(spaceId, 'Nope')
  const deniedCreate = await mcp(base, reader.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Nope', body: 'Nope' },
    },
  })
  const after = await pageCount(spaceId, 'Nope')
  const writer = await createToken(base, user.cookie, 'writer')
  const made = await mcp(base, writer.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: { space_id: spaceId, title: 'Kept', body: 'Kept' },
    },
  })
  if (made.status !== 200) fail('scope_create_failed')
  const page = toolPayload(made.text).data
  const deniedUpdate = await mcp(base, reader.token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'update_page',
      arguments: {
        page_id: page.id,
        title: 'Hacked',
        updated_at: page.updated_at,
      },
    },
  })
  const read = await mcp(base, reader.token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_page', arguments: { page_id: page.id } },
  })
  const viewed = toolPayload(read.text).data
  console.log(`read_create_status=${deniedCreate.status}`)
  console.log(`read_update_status=${deniedUpdate.status}`)
  console.log(`read_get_status=${read.status}`)
  console.log(`read_create_stored=${before === after ? 'false' : 'true'}`)
  console.log(`read_title_unchanged=${viewed.title === 'Kept'}`)
  if (
    deniedCreate.status !== 403 ||
    deniedUpdate.status !== 403 ||
    read.status !== 200 ||
    before !== after ||
    viewed.title !== 'Kept'
  ) {
    fail('scope')
  }
}

async function expiry(base: string) {
  const user = await signUp(base, 'Expiry')
  const created = await createToken(base, user.cookie, 'expiry', { expiry: '30d' })
  const live = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  console.log(`before_expiry_status=${live.status}`)
  await expireToken(created.id)
  const expired = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })
  const missing = await mcp(base, null, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
  })
  console.log(`expired_status=${expired.status}`)
  console.log(`expired_body_matches=${expired.text === missing.text}`)
  if (
    live.status !== 200 ||
    expired.status !== 401 ||
    missing.status !== 401 ||
    expired.text !== missing.text
  ) {
    fail('expiry')
  }
}

async function rate(base: string) {
  const user = await signUp(base, 'Rate')
  const created = await createToken(base, user.cookie, 'rate')
  let under = 0
  for (let i = 0; i < MCP_RATE_MAX; i += 1) {
    const response = await mcp(base, created.token, {
      jsonrpc: '2.0',
      id: i,
      method: 'ping',
    })
    under = response.status
    if (response.status !== 200) fail('rate_under_limit')
  }
  const blocked = await mcp(base, created.token, {
    jsonrpc: '2.0',
    id: MCP_RATE_MAX,
    method: 'ping',
  })
  console.log(`under_limit_status=${under}`)
  console.log(`rate_status=${blocked.status}`)
  console.log(`rate_limit=${MCP_RATE_MAX}`)
  if (blocked.status !== 429) fail('rate')
}

async function bodyCap(base: string) {
  const user = await signUp(base, 'Body')
  const created = await createToken(base, user.cookie, 'body')
  const spaceId = await personalSpace(base, created.token)
  const marker = `cap-${crypto.randomUUID()}`
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'create_page',
      arguments: {
        space_id: spaceId,
        title: marker,
        body: 'x'.repeat(20 * 1024 * 1024),
      },
    },
  })
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${created.token}`,
    },
    body: payload,
  })
  await response.text().catch(() => '')
  const stored = await pageCount(spaceId, marker)
  console.log(`body_status=${response.status}`)
  console.log(`body_limit_bytes=${MCP_MAX_BODY_BYTES}`)
  console.log(`request_bytes=${Buffer.byteLength(payload)}`)
  console.log(`stored_pages=${stored}`)
  if (response.status !== 413 || stored !== 0) fail('body_cap')
}

async function image(base: string) {
  const container = process.env.ATLAS_CONTAINER
  if (!container) fail('ATLAS_CONTAINER is required')
  const result = spawnSync(
    'docker',
    ['ps', '--format', '{{.Names}}\t{{.Image}}'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) fail('docker_ps_failed')
  const lines = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const apps = lines.filter((line) => line.includes('\tatlas-app'))
  const row = lines.find((line) => line.startsWith(`${container}\t`))
  const same = Boolean(row?.includes('\tatlas-app'))
  console.log(`app_containers=${apps.length}`)
  console.log(`mcp_container=${container}`)
  console.log(`same_image=${same}`)
  const probe = await mcp(base, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })
  console.log(`mcp_status=${probe.status}`)
  const got = await fetch(`${base}/mcp`)
  console.log(`mcp_get_status=${got.status}`)
  await got.text().catch(() => '')
  console.log(`extra_service=${apps.length === 1 ? 'false' : 'true'}`)
  if (apps.length !== 1 || !same || probe.status !== 401 || got.status !== 405) {
    fail('mcp_image')
  }
}

const mode = process.argv[2]
const base = baseUrl()
databaseUrl()

if (mode === 'revoked') await revoked(base)
else if (mode === 'cross') await cross(base)
else if (mode === 'secret') await secret(base)
else if (mode === 'bearer') await bearer(base)
else if (mode === 'writes') await writes(base)
else if (mode === 'team') await teamRemoval(base)
else if (mode === 'reset') await reset(base)
else if (mode === 'roundtrip') await roundTrip(base)
else if (mode === 'image') await image(base)
else if (mode === 'fidelity') await fidelity(base)
else if (mode === 'conflict') await conflict(base)
else if (mode === 'scope') await scopeRead(base)
else if (mode === 'expiry') await expiry(base)
else if (mode === 'rate') await rate(base)
else if (mode === 'body') await bodyCap(base)
else {
  fail(
    'usage: token-fail.ts revoked|cross|secret|bearer|writes|team|reset|roundtrip|image|fidelity|conflict|scope|expiry|rate|body',
  )
}
