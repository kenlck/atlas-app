import postgres from 'postgres'
import { isLocalPostgresHost } from '../src/lib/postgres-options'

// Refuse anything except an http URL on localhost. Called when a driver loads.
export function assertLocalBaseUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('refusing non-local BASE_URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'http:' || !local) {
    throw new Error('refusing non-local BASE_URL')
  }
  return url.toString().replace(/\/$/, '')
}

function refuseDatabase(): never {
  throw new Error('refusing non-local database')
}

function authorityOf(raw: string) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?]*)/i.exec(raw)
  if (!match) refuseDatabase()
  const scheme = match[1].toLowerCase()
  if (scheme !== 'postgres' && scheme !== 'postgresql') refuseDatabase()
  return match[2]
}

function hostOf(part: string) {
  if (part.startsWith('[')) {
    const end = part.indexOf(']')
    if (end < 2) refuseDatabase()
    return part.slice(1, end).toLowerCase()
  }
  const bare = part.split(':')[0] ?? ''
  if (!bare) refuseDatabase()
  try {
    return decodeURIComponent(bare).toLowerCase()
  } catch {
    refuseDatabase()
  }
}

// postgres-js takes the host after the first '@' and splits on ','.
function hostsPostgresWouldUse(raw: string) {
  const start = raw.indexOf('://')
  if (start < 0) refuseDatabase()
  const afterScheme = raw.slice(start + 3).split(/[/?]/)[0] ?? ''
  const at = afterScheme.indexOf('@')
  let host = at >= 0 ? afterScheme.slice(at + 1) : afterScheme
  try {
    host = decodeURIComponent(host)
  } catch {
    refuseDatabase()
  }
  const hosts = host.split(',').map((part) => hostOf(part))
  if (hosts.length === 0) refuseDatabase()
  return hosts
}

function libraryHosts(raw: string) {
  const sql = postgres(raw, { max: 0, idle_timeout: 0, connect_timeout: 0 })
  try {
    return sql.options.host.map((host) => {
      let value = host
      try {
        value = decodeURIComponent(host)
      } catch {
        refuseDatabase()
      }
      return value.toLowerCase()
    })
  } finally {
    void sql.end({ timeout: 0 })
  }
}

export function assertLocalPostgresUrl(raw: string) {
  try {
    const authority = authorityOf(raw)
    const ats = authority.split('@').length - 1
    if (authority.includes(',') || ats > 1) refuseDatabase()
    const intended = hostsPostgresWouldUse(raw)
    if (!intended.every((host) => isLocalPostgresHost(host))) refuseDatabase()
    const parsed = libraryHosts(raw)
    if (parsed.length === 0) refuseDatabase()
    for (const host of parsed) {
      if (isLocalPostgresHost(host)) continue
      if (host === '[' && intended.includes('::1')) continue
      refuseDatabase()
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'refusing non-local database') throw error
    refuseDatabase()
  }
}

export function assertLocalDatabaseUrl(raw: string) {
  try {
    assertLocalPostgresUrl(raw)
  } catch {
    throw new Error('refusing non-local DATABASE_URL')
  }
  return raw
}

export function stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function waitForClient(page: {
  waitForFunction: (fn: () => boolean) => Promise<unknown>
}) {
  await page.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
}

type AuthPage = {
  waitForFunction: (fn: () => boolean) => Promise<unknown>
  waitForResponse: (
    fn: (response: {
      url: () => string
      status: () => number
      headers: () => Record<string, string>
    }) => boolean,
  ) => Promise<{
    status: () => number
    headers: () => Record<string, string>
  }>
  getByRole: (
    role: 'button',
    options: { name: string },
  ) => { click: () => Promise<void> }
}

export async function submitAuthForm(
  page: AuthPage,
  buttonName: string,
  apiPath: string,
) {
  await waitForClient(page)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pending = page.waitForResponse((response) =>
      response.url().includes(apiPath),
    )
    await page.getByRole('button', { name: buttonName }).click()
    const response = await pending
    console.log(`auth_status=${response.status()} path=${apiPath}`)
    if (response.status() !== 429) return response
    const retryAfter = Number(response.headers()['x-retry-after'] ?? '10')
    const seconds = Number.isFinite(retryAfter) ? retryAfter + 1 : 11
    console.log(`auth_retry_after=${seconds}`)
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }
  throw new Error(`auth stayed rate limited for ${apiPath}`)
}

type NewDocButton = {
  click: () => Promise<void>
  getAttribute: (name: string) => Promise<string | null>
}

type NewDocPage = {
  getByRole: (
    role: 'button',
    options: { name: string; exact?: boolean },
  ) => NewDocButton & {
    first: () => NewDocButton
    last: () => NewDocButton
  }
}

export async function clickNewDoc(page: NewDocPage, which: 'first' | 'last' = 'last') {
  const button = page.getByRole('button', { name: '+ New page', exact: true })[which]()
  const popup = await button.getAttribute('aria-haspopup')
  await button.click()
  if (popup === 'menu') {
    await page.getByRole('button', { name: 'Page', exact: true }).click()
  }
}
