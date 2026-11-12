import { and, eq } from 'drizzle-orm'
import { closeDb, getDb } from '../src/lib/db.ts'
import { createPage } from '../src/lib/pages.ts'
import { page, space } from '../src/lib/schema.ts'
import { assertLocalBaseUrl, assertLocalDatabaseUrl } from './verify-local.ts'

const DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

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
  process.env.DATABASE_URL = url
  return url
}

function baseUrl() {
  if (!process.env.BASE_URL) fail('BASE_URL is required')
  return assertLocalBaseUrl(process.env.BASE_URL)
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

async function signUp(base: string) {
  const email = `origin.${crypto.randomUUID()}@example.com`
  const password = `origin-${crypto.randomUUID()}`
  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name: 'Save Origin', email, password }),
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
  if (response.status !== 200) fail('sign-up failed')
  const cookie = cookieHeader(response)
  if (!cookie) fail('signup_cookie=missing')
  const body = JSON.parse(text) as { user?: { id?: string } }
  if (!body.user?.id) fail('signup_user=missing')
  return { cookie, id: body.user.id }
}

async function snapshot(pageId: string) {
  const rows = await getDb()
    .select({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      body: page.body,
      bodyText: page.bodyText,
      position: page.position,
      updatedBy: page.updatedBy,
      updatedAt: page.updatedAt,
    })
    .from(page)
    .where(eq(page.id, pageId))
    .limit(1)
  const row = rows[0]
  if (!row) fail('page missing')
  return JSON.stringify({ ...row, updatedAt: row.updatedAt.toISOString() })
}

async function postSave(
  base: string,
  cookie: string,
  origin: string | null,
  body: unknown,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    cookie,
  }
  if (origin !== null) headers.origin = origin
  const response = await fetch(`${base}/api/pages/save`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  await response.text().catch(() => '')
  return response.status
}

async function main() {
  databaseUrl()
  const base = baseUrl()
  const origin = new URL(base).origin
  const { cookie, id } = await signUp(base)
  const spaces = await getDb()
    .select()
    .from(space)
    .where(and(eq(space.kind, 'personal'), eq(space.ownerUserId, id)))
    .limit(1)
  const mine = spaces[0]
  if (!mine) fail('personal space missing')
  const created = await createPage(id, { spaceId: mine.id, title: 'Origin' })
  const before = await snapshot(created.id)
  const good = {
    pageId: created.id,
    title: 'Origin',
    body: DOC,
  }

  const missing = await postSave(base, cookie, null, good)
  const afterMissing = await snapshot(created.id)
  console.log(`missing_origin_status=${missing}`)
  console.log(`missing_origin_unchanged=${afterMissing === before}`)

  const mismatched = await postSave(base, cookie, 'http://evil.example', good)
  const afterMismatch = await snapshot(created.id)
  console.log(`mismatched_origin_status=${mismatched}`)
  console.log(`mismatched_origin_unchanged=${afterMismatch === before}`)

  const malformed = await postSave(base, cookie, origin, {
    pageId: created.id,
    title: 'Origin',
    body: 'not-a-doc',
  })
  const afterMalformed = await snapshot(created.id)
  console.log(`malformed_status=${malformed}`)
  console.log(`malformed_unchanged=${afterMalformed === before}`)

  const accepted = await postSave(base, cookie, origin, {
    pageId: created.id,
    title: 'Accepted',
    body: DOC,
  })
  const after = JSON.parse(await snapshot(created.id)) as { title?: string }
  const changed = (await snapshot(created.id)) !== before
  console.log(`matching_origin_status=${accepted}`)
  console.log(
    `matching_origin_accepted=${accepted === 204 && changed && after.title === 'Accepted'}`,
  )

  if (missing !== 403 || afterMissing !== before) fail('missing origin wrote')
  if (mismatched !== 403 || afterMismatch !== before) fail('mismatched origin wrote')
  if (malformed !== 400 || afterMalformed !== before) fail('malformed body wrote')
  if (accepted !== 204 || !changed || after.title !== 'Accepted') {
    fail('matching origin was not accepted')
  }
  await closeDb()
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.split('\n')[0] : 'save-origin failed'
  console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]'))
  process.exit(1)
})
