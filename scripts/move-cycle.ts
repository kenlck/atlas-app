import { randomBytes, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { postgresPoolOptions } from '../src/lib/postgres-options'
import { assertLocalBaseUrl, assertLocalDatabaseUrl } from './verify-local.ts'

const CYCLE_ERROR = 'Cannot move a page under itself or a descendant'

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

function redact(text: string, password: string) {
  let next = text
  if (password) next = next.split(password).join('[redacted]')
  return next
    .replace(
      /better-auth\.session_token=[^;\s]+/g,
      'better-auth.session_token=[redacted]',
    )
    .replace(/("token"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("password"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
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

async function signUp(base: string, password: string) {
  const email = `move-cycle.${randomUUID()}@example.com`
  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name: 'Move Cycle', email, password }),
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
  if (response.status !== 200) fail(redact(text, password).slice(0, 240))
  const cookie = cookieHeader(response)
  if (!cookie) fail('signup_cookie=missing')
  const body = JSON.parse(text) as { user?: { id?: string } }
  if (!body.user?.id) fail('signup_user=missing')
  return { cookie, id: body.user.id }
}

function serverFnPayload(data: unknown) {
  let next = 0
  const node = (value: unknown): unknown => {
    if (value === null) return { t: 2, s: 0 }
    if (typeof value === 'string') return { t: 1, s: value }
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

async function loadServerFns() {
  const dir = '.output/server/_ssr'
  const files = (await readdir(dir)).filter(
    (name) => name.startsWith('fns-') && name.endsWith('.mjs'),
  )
  const pattern =
    /var (\w+)_createServerFn_handler = createServerRpc\(\{\s*id: "([a-f0-9]{64})"[\s\S]*?createServerFn\(\{ method: "(GET|POST)" \}\)/g
  const found = new Map<string, { id: string; method: 'GET' | 'POST' }>()
  for (const file of files) {
    const text = await readFile(`${dir}/${file}`, 'utf8')
    for (const match of text.matchAll(pattern)) {
      const name = match[1]
      const id = match[2]
      const method = match[3]
      if (!name || !id || (method !== 'GET' && method !== 'POST')) continue
      found.set(name, { id, method })
    }
  }
  const createPageFn = found.get('createPageFn')
  const movePageFn = found.get('movePageFn')
  if (!createPageFn || !movePageFn)
    fail('server function ids were not in the build')
  return { createPageFn, movePageFn }
}

async function postServerFn(
  base: string,
  cookie: string,
  fn: { id: string },
  data: Record<string, unknown>,
  password: string,
) {
  const response = await fetch(`${base}/_serverFn/${fn.id}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'content-type': 'application/json',
      'x-tsr-serverFn': 'true',
    },
    body: JSON.stringify(serverFnPayload({ data })),
  })
  const text = await response.text()
  return { status: response.status, text: redact(text, password) }
}

type PageRow = { id: string; title: string; parent_id: string | null }

function pageByTitle(rows: PageRow[], title: string) {
  const row = rows.find((item) => item.title === title)
  if (!row) fail(`missing page ${title}`)
  return row
}

function parentLine(rows: PageRow[]) {
  return ['A', 'B', 'C']
    .map((title) => {
      const row = pageByTitle(rows, title)
      return `${title}:${row.parent_id ?? 'null'}`
    })
    .join(',')
}

async function readPages(sql: postgres.Sql, spaceId: string) {
  return sql<PageRow[]>`
    select id, title, parent_id
    from page
    where space_id = ${spaceId}
      and title in ('A', 'B', 'C')
      and archived_at is null
  `
}

async function main() {
  const base = baseUrl()
  const url = databaseUrl()
  const password = randomBytes(24).toString('base64url')
  const sql = postgres(url, { ...postgresPoolOptions(url), max: 1 })
  try {
    const user = await signUp(base, password)
    const spaces = await sql<{ id: string }[]>`
      select id from space
      where owner_user_id = ${user.id} and kind = 'personal'
      limit 1
    `
    const spaceId = spaces[0]?.id
    if (!spaceId) fail('personal_space=missing')
    const fns = await loadServerFns()
    console.log('server_fns=createPageFn,movePageFn')

    const createdA = await postServerFn(
      base,
      user.cookie,
      fns.createPageFn,
      { spaceId, parentId: null, title: 'A' },
      password,
    )
    console.log(`create_A_status=${createdA.status}`)
    if (createdA.status !== 200) fail('create A failed')
    const pageA = pageByTitle(await readPages(sql, spaceId), 'A')

    const createdB = await postServerFn(
      base,
      user.cookie,
      fns.createPageFn,
      { spaceId, parentId: pageA.id, title: 'B' },
      password,
    )
    console.log(`create_B_status=${createdB.status}`)
    if (createdB.status !== 200) fail('create B failed')
    const pageB = pageByTitle(await readPages(sql, spaceId), 'B')

    const createdC = await postServerFn(
      base,
      user.cookie,
      fns.createPageFn,
      { spaceId, parentId: pageB.id, title: 'C' },
      password,
    )
    console.log(`create_C_status=${createdC.status}`)
    if (createdC.status !== 200) fail('create C failed')

    const beforeRows = await readPages(sql, spaceId)
    const before = parentLine(beforeRows)
    const a = pageByTitle(beforeRows, 'A')
    const b = pageByTitle(beforeRows, 'B')
    const c = pageByTitle(beforeRows, 'C')
    const built =
      a.parent_id === null && b.parent_id === a.id && c.parent_id === b.id
    console.log(`parents_before=${before}`)
    console.log(`tree_built=${built}`)
    if (!built) fail('tree was not A > B > C')

    const grandchild = await postServerFn(
      base,
      user.cookie,
      fns.movePageFn,
      { pageId: a.id, parentId: c.id },
      password,
    )
    const afterGrandchildRows = await readPages(sql, spaceId)
    const afterGrandchild = parentLine(afterGrandchildRows)
    console.log(`grandchild_status=${grandchild.status}`)
    console.log(
      `grandchild_error_clear=${grandchild.text.includes(CYCLE_ERROR)}`,
    )
    console.log(`parents_after_grandchild=${afterGrandchild}`)
    console.log(`parents_unchanged=${afterGrandchild === before}`)
    if (
      grandchild.status !== 400 ||
      !grandchild.text.includes(CYCLE_ERROR) ||
      afterGrandchild !== before
    ) {
      fail('move under grandchild was not refused')
    }

    const self = await postServerFn(
      base,
      user.cookie,
      fns.movePageFn,
      { pageId: a.id, parentId: a.id },
      password,
    )
    const afterSelfRows = await readPages(sql, spaceId)
    const afterSelf = parentLine(afterSelfRows)
    console.log(`self_status=${self.status}`)
    console.log(`self_error_clear=${self.text.includes(CYCLE_ERROR)}`)
    console.log(`parents_after_self=${afterSelf}`)
    console.log(`self_unchanged=${afterSelf === before}`)
    if (
      self.status !== 400 ||
      !self.text.includes(CYCLE_ERROR) ||
      afterSelf !== before
    ) {
      fail('move under itself was not refused')
    }

    const valid = await postServerFn(
      base,
      user.cookie,
      fns.movePageFn,
      { pageId: c.id, parentId: a.id },
      password,
    )
    const afterValidRows = await readPages(sql, spaceId)
    const afterValid = parentLine(afterValidRows)
    const validA = pageByTitle(afterValidRows, 'A')
    const validB = pageByTitle(afterValidRows, 'B')
    const validC = pageByTitle(afterValidRows, 'C')
    const validUpdated =
      valid.status === 200 &&
      validA.parent_id === null &&
      validB.parent_id === a.id &&
      validC.parent_id === a.id &&
      afterValid !== before
    console.log(`valid_status=${valid.status}`)
    console.log(`parents_after_valid=${afterValid}`)
    console.log(`valid_parent_updated=${validUpdated}`)
    if (!validUpdated) fail('legal move was blocked')
    console.log('move_cycle=pass')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  const text = error instanceof Error ? error.message : 'move-cycle failed'
  console.error(redact(text, '').slice(0, 300))
  process.exit(1)
})
