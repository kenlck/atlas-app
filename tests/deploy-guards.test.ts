import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { adminCallerIp, resetAdminRateLimit } from '../src/lib/admin-reset'
import { requestWithClientIp } from '../src/lib/client-ip'
import { handlePageSave } from '../src/lib/page-save-request'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs')
const ORIGIN = 'http://127.0.0.1:3000'
const LOCAL_DATABASE = 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test'
const DUMMY_AUTH = 'dummy-better-auth-secret-32-chars'
const DUMMY_ADMIN = 'dummy-admin-api-secret-32-characters'

function boot(overrides: Record<string, string | undefined>, unset: string[] = []) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: LOCAL_DATABASE,
    BETTER_AUTH_SECRET: DUMMY_AUTH,
    BETTER_AUTH_URL: ORIGIN,
    ADMIN_API_SECRET: DUMMY_ADMIN,
    ...overrides,
  }
  for (const name of unset) delete env[name]
  return spawnSync(process.execPath, [TSX, 'scripts/boot-check.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
    env,
  })
}

function outputOf(result: ReturnType<typeof boot>) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

describe('production boot', () => {
  it('refuses to boot when BETTER_AUTH_SECRET is missing', () => {
    const missing = boot({}, ['BETTER_AUTH_SECRET'])
    const empty = boot({ BETTER_AUTH_SECRET: '' })
    for (const result of [missing, empty]) {
      const output = outputOf(result)
      expect(result.status).not.toBe(0)
      expect(output).toContain('BETTER_AUTH_SECRET is required')
      expect(output).not.toContain(DUMMY_AUTH)
      expect(output).not.toContain(DUMMY_ADMIN)
      expect(output).not.toContain('127.0.0.1:5432')
    }
  })

  it('refuses to boot when ADMIN_API_SECRET is missing', () => {
    const missing = boot({}, ['ADMIN_API_SECRET'])
    const empty = boot({ ADMIN_API_SECRET: '' })
    for (const result of [missing, empty]) {
      const output = outputOf(result)
      expect(result.status).not.toBe(0)
      expect(output).toContain('ADMIN_API_SECRET is required')
      expect(output).not.toContain(DUMMY_AUTH)
      expect(output).not.toContain(DUMMY_ADMIN)
      expect(output).not.toContain('127.0.0.1:5432')
    }
  })
})

describe('client ip', () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY
    delete process.env.TRUSTED_PROXY_HOPS
    resetAdminRateLimit()
  })

  it('uses the socket peer when TRUST_PROXY is unset', () => {
    const request = new Request('http://127.0.0.1/', {
      headers: { 'x-forwarded-for': 'spoof, real-client, proxy' },
    })
    expect(adminCallerIp(request, '198.51.100.8')).toBe('198.51.100.8')
  })

  it('keeps the right-hand hop when the request is not a native Request', async () => {
    process.env.TRUST_PROXY = '1'
    const body = JSON.stringify({ ok: true })
    const fake = {
      url: 'http://127.0.0.1:3000/api/auth/sign-in/email',
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.9, 198.51.100.20, 192.0.2.10',
      }),
      body: new Blob([body]).stream(),
      signal: new AbortController().signal,
    }
    Object.setPrototypeOf(fake, Request.prototype)
    expect(fake instanceof Request).toBe(true)
    expect(() => new Request(fake as Request)).toThrow()
    const scoped = requestWithClientIp(fake as Request, '198.51.100.8')
    expect(scoped.headers.get('x-forwarded-for')).toBe('192.0.2.10')
    expect(await scoped.text()).toBe(body)
  })

  it('counts a fixed number of hops from the right of X-Forwarded-For', () => {
    process.env.TRUST_PROXY = '1'
    const request = new Request('http://127.0.0.1/', {
      headers: { 'x-forwarded-for': 'spoof, real-client, proxy' },
    })
    expect(adminCallerIp(request, '198.51.100.8')).toBe('proxy')
    process.env.TRUSTED_PROXY_HOPS = '2'
    expect(adminCallerIp(request, '198.51.100.8')).toBe('real-client')
    process.env.TRUSTED_PROXY_HOPS = '5'
    expect(adminCallerIp(request, '198.51.100.8')).toBe('198.51.100.8')
  })

  it('does not rate limit on a spoofed leftmost X-Forwarded-For hop', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: LOCAL_DATABASE,
      BETTER_AUTH_SECRET: DUMMY_AUTH,
      BETTER_AUTH_URL: ORIGIN,
      ADMIN_API_SECRET: DUMMY_ADMIN,
      TRUST_PROXY: '1',
      BETTER_AUTH_TELEMETRY: '0',
      // tests/setup.ts already applied migrations for this database.
      ATLAS_DB_MIGRATED: '1',
    }
    delete env.TRUSTED_PROXY_HOPS
    const result = spawnSync(process.execPath, [TSX, 'scripts/verify-client-ip.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status, output).toBe(0)
    expect(output).toContain('header=spoof, real-client, proxy')
    expect(output).toContain('resolved=proxy')
    expect(output).toContain('admin_sixth=429')
    expect(output).toContain('auth_other_hop=')
    expect(output).not.toContain('auth_other_hop=429')
    expect(output).not.toContain(DUMMY_AUTH)
    expect(output).not.toContain(DUMMY_ADMIN)
    expect(output).not.toContain('127.0.0.1:5432')
  }, 40000)
})

function saveRequest(origin: string, body: string) {
  return new Request(`${ORIGIN}/api/pages/save`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
    },
    body,
  })
}

describe('page save request', () => {
  afterEach(() => {
    process.env.BETTER_AUTH_URL = ORIGIN
  })

  it('rejects a cross-origin save', async () => {
    process.env.BETTER_AUTH_URL = ORIGIN
    const response = await handlePageSave(
      saveRequest(
        'http://evil.example',
        JSON.stringify({
          pageId: 'page-1',
          title: 'Notes',
          body: { type: 'doc', content: [] },
        }),
      ),
    )
    expect(response.status).toBe(403)
  })

  it('rejects a malformed save body', async () => {
    process.env.BETTER_AUTH_URL = ORIGIN
    const response = await handlePageSave(
      saveRequest(
        ORIGIN,
        JSON.stringify({ pageId: 'page-1', title: 'Notes', body: 'not-a-doc' }),
      ),
    )
    expect(response.status).toBe(400)
  })
})
