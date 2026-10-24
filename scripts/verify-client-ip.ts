import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { handleResetPassword, resetAdminRateLimit } from '../src/lib/admin-reset.ts'
import { handleAuthRequest } from '../src/lib/auth-guard.ts'
import { resolveClientIp } from '../src/lib/client-ip.ts'
import { closeDb } from '../src/lib/db.ts'
import { postgresPoolOptions } from '../src/lib/postgres-options.ts'
import { assertLocalDatabaseUrl } from './verify-local.ts'

const HEADER = 'spoof, real-client, proxy'
const SOCKET = '198.51.100.8'
const ORIGIN = process.env.BETTER_AUTH_URL || 'http://127.0.0.1:3000'
const WRONG_BEARER = 'x'.repeat(32)

function fail(message: string): never {
  throw new Error(message)
}

function redact(text: string) {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
}

async function authStatus(xff: string, socketIp: string) {
  const response = await handleAuthRequest(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': xff,
      },
      body: JSON.stringify({
        email: 'nobody@example.com',
        password: 'not-a-real-password',
      }),
    }),
    socketIp,
  )
  return response.status
}

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    fail('NODE_ENV=production is required so the auth rate limiter is on')
  }
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) fail('DATABASE_URL is required')
  assertLocalDatabaseUrl(databaseUrl)
  if (!process.env.ADMIN_API_SECRET || process.env.ADMIN_API_SECRET.length < 32) {
    process.env.ADMIN_API_SECRET = 'dummy-admin-api-secret-32-characters'
  }
  process.env.TRUST_PROXY = '1'
  delete process.env.TRUSTED_PROXY_HOPS

  const sql = postgres(databaseUrl, { ...postgresPoolOptions(databaseUrl), max: 1 })
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle'),
    })
  } catch (error) {
    fail(redact(error instanceof Error ? error.message : 'migrate failed'))
  } finally {
    await sql.end({ timeout: 5 })
  }

  const resolved = resolveClientIp(
    new Request('http://127.0.0.1/api/admin/reset-password', {
      headers: { 'x-forwarded-for': HEADER },
    }),
    SOCKET,
  )
  console.log(`header=${HEADER}`)
  console.log(`resolved=${resolved}`)
  console.log('leftmost=spoof')
  console.log(`right_hand_hop=${resolved === 'proxy'}`)
  if (resolved !== 'proxy') fail('expected the right-hand hop')

  resetAdminRateLimit()
  let adminSixth = 0
  for (let i = 1; i <= 6; i += 1) {
    adminSixth = (
      await handleResetPassword(
        new Request('http://127.0.0.1/api/admin/reset-password', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WRONG_BEARER}`,
            'x-forwarded-for': `spoof-${i}, real-client, proxy`,
          },
          body: JSON.stringify({ email: 'nobody@example.com' }),
        }),
        SOCKET,
      )
    ).status
  }
  console.log(`admin_sixth=${adminSixth}`)
  if (adminSixth !== 429) fail(`admin rate limit expected 429, got ${adminSixth}`)

  const adminOther = (
    await handleResetPassword(
      new Request('http://127.0.0.1/api/admin/reset-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WRONG_BEARER}`,
          'x-forwarded-for': 'spoof, real-client, other-proxy',
        },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      }),
      SOCKET,
    )
  ).status
  console.log(`admin_other_hop=${adminOther}`)
  if (adminOther === 429) fail('admin limiter used a shared bucket instead of the right-hand hop')

  const right = '192.0.2.10'
  const authStatuses: number[] = []
  for (let i = 1; i <= 4; i += 1) {
    authStatuses.push(await authStatus(`203.0.113.${i}, 198.51.100.20, ${right}`, SOCKET))
  }
  console.log(`auth_statuses=${authStatuses.join(',')}`)
  if (authStatuses[3] !== 429) fail('auth limiter did not key on the right-hand hop')

  const authOther = await authStatus('203.0.113.50, 198.51.100.20, 192.0.2.99', SOCKET)
  console.log(`auth_other_hop=${authOther}`)
  if (authOther === 429) fail('auth limiter ignored the right-hand hop')
  console.log('xff_pass=true')
}

main()
  .catch((error) => {
    console.error(redact(error instanceof Error ? error.message : 'verify client ip failed'))
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
