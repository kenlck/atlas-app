import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { handleResetPassword, resetAdminRateLimit } from '../src/lib/admin-reset.ts'
import { getAuth } from '../src/lib/auth.ts'
import { closeDb } from '../src/lib/db.ts'
import { postgresPoolOptions } from '../src/lib/postgres-options.ts'
import { assertLocalDatabaseUrl } from './verify-local.ts'

const BAD_IP = '203.0.113.10'
const OTHER_IP = '203.0.113.20'
const SUCCESS_IP = '203.0.113.30'
const WRONG_BEARER = 'x'.repeat(32)

const hidden: string[] = []

function hide(value: string) {
  if (value.length >= 12) hidden.push(value)
}

function redact(text: string) {
  let out = text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
  const values = [...hidden].sort((a, b) => b.length - a.length)
  for (const value of values) out = out.split(value).join('[redacted]')
  return out
}

function fail(message: string): never {
  throw new Error(redact(message))
}

function resetRequest(bearer: string, email: string) {
  return new Request('http://127.0.0.1/api/admin/reset-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ email }),
  })
}

async function call(bearer: string, email: string, ip: string) {
  const response = await handleResetPassword(resetRequest(bearer, email), ip)
  const text = await response.text()
  let passwordLen = 0
  if (response.status === 200) {
    try {
      const parsed = JSON.parse(text) as { temporaryPassword?: unknown }
      if (typeof parsed.temporaryPassword === 'string') {
        hide(parsed.temporaryPassword)
        passwordLen = parsed.temporaryPassword.length
      }
    } catch {
      passwordLen = 0
    }
  }
  return { status: response.status, passwordLen }
}

async function main() {
  if (process.env.DATABASE_URL) {
    console.log('inherited_database_url=ignored')
    delete process.env.DATABASE_URL
  }
  console.log(`database_url_visible=${process.env.DATABASE_URL ? 'true' : 'false'}`)

  const testUrl = process.env.TEST_DATABASE_URL
  if (!testUrl) fail('TEST_DATABASE_URL is required')
  assertLocalDatabaseUrl(testUrl)
  hide(testUrl)

  delete process.env.TRUST_PROXY
  delete process.env.TRUSTED_PROXY_HOPS
  console.log('trust_proxy=unset')

  const adminSecret = randomBytes(32).toString('hex')
  hide(adminSecret)
  process.env.ADMIN_API_SECRET = adminSecret
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
  }
  hide(process.env.BETTER_AUTH_SECRET)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || 'http://127.0.0.1:3000'

  resetAdminRateLimit()
  // Failures must not open a database. Leave DATABASE_URL unset so a lookup throws.
  delete process.env.DATABASE_URL

  const bad: number[] = []
  for (let i = 1; i <= 6; i += 1) {
    bad.push((await call(WRONG_BEARER, `nobody-${i}@example.com`, BAD_IP)).status)
  }
  console.log(`bad_statuses=${bad.join(',')}`)
  if (!(bad.slice(0, 5).every((code) => code === 401) && bad[5] === 429)) {
    fail(`bad tokens from one ip expected 401 x5 then 429, got ${bad.join(',')}`)
  }

  const limited = (await call(adminSecret, 'nobody-limited@example.com', BAD_IP)).status
  console.log(`limited_ip_valid_status=${limited}`)
  if (limited !== 429) fail(`valid token on a limited ip expected 429, got ${limited}`)

  process.env.DATABASE_URL = testUrl
  if (process.env.ATLAS_DB_MIGRATED !== '1') {
    const sql = postgres(testUrl, { ...postgresPoolOptions(testUrl), max: 1 })
    try {
      await migrate(drizzle(sql), {
        migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
      })
    } catch (error) {
      fail(redact(error instanceof Error ? error.message : 'migrate failed'))
    } finally {
      await sql.end({ timeout: 5 })
    }
  }

  const email = `bearer.${randomBytes(4).toString('hex')}@example.com`
  const password = randomBytes(24).toString('hex')
  hide(password)
  let signedUp = false
  try {
    const result = await getAuth().api.signUpEmail({
      body: { name: 'Bearer Check', email, password },
    })
    signedUp = Boolean(result.user?.id)
  } catch (error) {
    fail(redact(error instanceof Error ? error.message : 'sign-up failed'))
  }
  if (!signedUp) fail('sign-up failed')

  const other = await call(adminSecret, email, OTHER_IP)
  console.log(`other_ip_status=${other.status}`)
  console.log(`other_ip_password_len=${other.passwordLen}`)
  if (other.status !== 200 || other.passwordLen < 8) {
    fail(`valid token from another ip expected 200, got ${other.status}`)
  }

  const successes: number[] = []
  for (let i = 1; i <= 6; i += 1) {
    successes.push((await call(adminSecret, email, SUCCESS_IP)).status)
  }
  console.log(`success_statuses=${successes.join(',')}`)
  const successOk = successes.every((code) => code === 200)
  console.log(`success_does_not_consume=${successOk}`)
  if (!successOk) fail(`successful resets consumed the limit: ${successes.join(',')}`)

  const after = (await call(WRONG_BEARER, email, SUCCESS_IP)).status
  console.log(`after_success_bad=${after}`)
  if (after !== 401) fail(`successes consumed the failure budget, bad token got ${after}`)
  console.log('admin_bearer_pass=true')
}

main()
  .catch((error) => {
    console.error(redact(error instanceof Error ? error.message : 'verify admin bearer failed'))
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
