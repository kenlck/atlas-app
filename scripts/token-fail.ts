import { spawnSync } from 'node:child_process'
import postgres from 'postgres'
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
  return { cookie }
}

async function createToken(
  base: string,
  cookie: string,
  input: { name: string; scope?: string; expiresIn?: string },
) {
  const response = await fetch(`${base}/api/atlas/tokens`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
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
  const created = await createToken(base, user.cookie, {
    name: 'revoked',
    scope: 'read',
    expiresIn: 'never',
  })
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
  const ownerToken = await createToken(base, owner.cookie, {
    name: 'owner',
    scope: 'read_write',
    expiresIn: 'never',
  })
  const otherToken = await createToken(base, other.cookie, {
    name: 'other',
    scope: 'read',
    expiresIn: 'never',
  })
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
  const created = await createToken(base, user.cookie, {
    name: 'secret',
    scope: 'read',
    expiresIn: '90d',
  })
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
  console.log(`missing_bearer_status=${missing.status}`)
  console.log(`garbage_bearer_status=${garbage.status}`)
  const same = missing.text === garbage.text
  console.log(`bearer_bodies_match=${same}`)
  const leaks = /exist|revok|expir|invalid token|not found/i.test(missing.text)
  console.log(`bearer_body_leaks_existence=${leaks}`)
  if (missing.status !== 401 || garbage.status !== 401 || !same || leaks) {
    fail('bearer_auth')
  }
}

const mode = process.argv[2]
const base = baseUrl()
databaseUrl()

if (mode === 'revoked') await revoked(base)
else if (mode === 'cross') await cross(base)
else if (mode === 'secret') await secret(base)
else if (mode === 'bearer') await bearer(base)
else fail('usage: token-fail.ts revoked|cross|secret|bearer')
