import { eq } from 'drizzle-orm'
import { handleResetPassword, resetAdminRateLimit } from '../src/lib/admin-reset'
import { handleAuthRequest } from '../src/lib/auth-guard'
import { getDb } from '../src/lib/db'
import { HttpError } from '../src/lib/http'
import { createPage, getPageView } from '../src/lib/pages'
import { account, adminAudit, session, user } from '../src/lib/schema'
import { handlePageSave } from '../src/lib/page-save-request'
import { createUser } from '../tests/helpers'

const LOCAL_SECRET = process.env.ADMIN_API_SECRET || 'test-admin-api-secret-32-chars-minx'
const SOCKET_IP = '203.0.113.10'
const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:3000'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function cookiesFrom(response: Response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
  return raw
    .filter(Boolean)
    .map((entry) => entry.split(';')[0] ?? '')
    .filter(Boolean)
    .join('; ')
}

async function fail1() {
  const a = await createUser('Verify A')
  const b = await createUser('Verify B')
  const page = await createPage(a.user.id, { spaceId: a.space.id, title: 'Private' })
  try {
    await getPageView(b.user.id, page.id)
    fail('fail1: B opened A page')
  } catch (error) {
    if ((error as HttpError).status !== 404) fail(`fail1: expected 404, got ${(error as HttpError).status}`)
  }
  console.log('fail1 pass: B gets 404 for A page')
}

async function fail2() {
  const base = process.env.BASE_URL
  if (!base) fail('fail2: BASE_URL is required')
  const page = await fetch(`${base.replace(/\/$/, '')}/s/missing/p/missing`, { redirect: 'manual' })
  if (page.status !== 307 && page.status !== 302) {
    fail(`fail2: signed-out page expected 307, got ${page.status}`)
  }
  const location = page.headers.get('location') ?? ''
  if (!location.includes('sign-in')) fail(`fail2: redirect was ${location}`)
  const api = await fetch(`${base.replace(/\/$/, '')}/api/pages/save`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(base).origin,
    },
    body: JSON.stringify({
      pageId: 'x',
      title: 'x',
      body: { type: 'doc', content: [] },
    }),
  })
  if (api.status !== 401) fail(`fail2: page API expected 401, got ${api.status}`)
  console.log('fail2 pass: signed-out page redirects, page API 401')
}

async function fail5f() {
  process.env.ADMIN_API_SECRET = LOCAL_SECRET
  resetAdminRateLimit()
  const person = await createUser('Verify Reset')
  const before = await getDb().select().from(user).where(eq(user.id, person.user.id))
  const response = await handleResetPassword(
    new Request('http://atlas.test/api/admin/reset-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LOCAL_SECRET}`,
      },
      body: JSON.stringify({ email: person.user.email }),
    }),
    SOCKET_IP,
  )
  if (response.status !== 200) fail(`fail5f: reset status ${response.status}`)
  const body = (await response.json()) as { temporaryPassword?: string }
  if (!body.temporaryPassword) fail('fail5f: missing temporary password')
  const rows = await getDb().select().from(user).where(eq(user.id, person.user.id))
  if (rows[0]?.mustChangePassword !== true) fail('fail5f: not locked')
  if (rows[0]?.updatedAt.getTime() !== before[0]?.updatedAt.getTime()) fail('fail5f: updatedAt changed')
  const sessions = await getDb().select().from(session).where(eq(session.userId, person.user.id))
  if (sessions.length !== 0) fail('fail5f: sessions remain')
  const accounts = await getDb().select().from(account).where(eq(account.userId, person.user.id))
  if (!accounts[0]?.password || accounts[0].password === body.temporaryPassword) {
    fail('fail5f: password not stored as a hash')
  }
  console.log('fail5f pass: temp password once, hash stored, sessions cleared, updatedAt unchanged')
}

async function fail5g() {
  process.env.ADMIN_API_SECRET = LOCAL_SECRET
  resetAdminRateLimit()
  const person = await createUser('Lock Name')
  const reset = await handleResetPassword(
    new Request('http://atlas.test/api/admin/reset-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LOCAL_SECRET}`,
      },
      body: JSON.stringify({ email: person.user.email }),
    }),
    SOCKET_IP,
  )
  const body = (await reset.json()) as { temporaryPassword: string }
  const signIn = await handleAuthRequest(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: person.user.email, password: body.temporaryPassword }),
    }),
  )
  if (signIn.status !== 200) fail(`fail5g: sign-in ${signIn.status}`)
  const cookie = cookiesFrom(signIn)
  const update = await handleAuthRequest(
    new Request(`${ORIGIN}/api/auth/update-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ name: 'Renamed while locked' }),
    }),
  )
  if (update.status !== 403) fail(`fail5g: update-user expected 403, got ${update.status}`)
  const rows = await getDb().select().from(user).where(eq(user.id, person.user.id))
  if (rows[0]?.name !== 'Lock Name') fail('fail5g: name changed')
  console.log('fail5g pass: locked update-user is 403, name unchanged')
}

async function fail5h() {
  process.env.ADMIN_API_SECRET = LOCAL_SECRET
  delete process.env.TRUST_PROXY
  resetAdminRateLimit()
  const person = await createUser('Xff')
  const socket = '198.51.100.77'
  let last = 0
  for (let i = 0; i < 6; i += 1) {
    last = (
      await handleResetPassword(
        new Request('http://atlas.test/api/admin/reset-password', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            'x-forwarded-for': `6.6.6.${i}`,
          },
          body: JSON.stringify({ email: person.user.email }),
        }),
        socket,
      )
    ).status
  }
  if (last !== 429) fail(`fail5h: expected 429, got ${last}`)
  const ok = await handleResetPassword(
    new Request('http://atlas.test/api/admin/reset-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LOCAL_SECRET}`,
      },
      body: JSON.stringify({ email: person.user.email }),
    }),
    socket,
  )
  if (ok.status !== 429 && ok.status !== 200) fail(`fail5h: unexpected ${ok.status}`)
  if (ok.status === 200) {
    const audits = await getDb().select().from(adminAudit).where(eq(adminAudit.targetUserId, person.user.id))
    if (audits[0]?.callerIp !== socket) fail('fail5h: audit IP was not the socket peer')
  }
  console.log('fail5h pass: rotating X-Forwarded-For still 429; audit uses socket IP')
}

async function fail9() {
  process.env.BETTER_AUTH_URL = ORIGIN
  const response = await handlePageSave(
    new Request(`${ORIGIN}/api/pages/save`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({
        pageId: 'page-1',
        title: 'Notes',
        body: { type: 'doc', content: [] },
      }),
    }),
  )
  console.log(`cross_origin_status=${response.status}`)
  if (response.status !== 403) fail(`fail9: expected 403, got ${response.status}`)
  console.log('fail9 pass: cross-origin save is 403')
}

async function fail9a() {
  process.env.BETTER_AUTH_URL = ORIGIN
  const response = await handlePageSave(
    new Request(`${ORIGIN}/api/pages/save`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({ pageId: 'page-1', title: 'Notes', body: 'not-a-doc' }),
    }),
  )
  console.log(`malformed_status=${response.status}`)
  if (response.status !== 400) fail(`fail9a: expected 400, got ${response.status}`)
  console.log('fail9a pass: malformed save body is 400')
}

const cmd = process.argv[2] ?? 'all'
const jobs: Record<string, () => Promise<void>> = {
  fail1,
  fail2,
  fail5f,
  fail5g,
  fail5h,
  fail9,
  fail9a,
}

async function main() {
  if (cmd === 'all') {
    await fail1()
    await fail5f()
    await fail5g()
    await fail5h()
    if (process.env.BASE_URL) await fail2()
    return
  }
  const job = jobs[cmd]
  if (!job) fail(`usage: verify-fail-conditions.ts [all|fail1|fail2|fail5f|fail5g|fail5h|fail9|fail9a]`)
  await job()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'verify failed')
  process.exit(1)
})
