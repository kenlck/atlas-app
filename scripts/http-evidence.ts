import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type BrowserContext, type Page } from 'playwright'
import {
  assertLocalBaseUrl,
  assertLocalDatabaseUrl,
  submitAuthForm,
  waitForClient,
} from './verify-local.ts'

const execFileAsync = promisify(execFile)
const BASE_URL = assertLocalBaseUrl(
  process.env.BASE_URL ?? 'http://127.0.0.1:3010',
)
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'evidence-password-ok'
const ADMIN_SECRET = process.env.ADMIN_API_SECRET ?? ''
const NEW_PASSWORD = 'new-password-ok'

function redact(text: string) {
  return text
    .replace(
      /better-auth\.session_token=[^;\s]+/g,
      'better-auth.session_token=[redacted]',
    )
    .replace(/("temporaryPassword"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("token"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("password"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
}

async function curl(args: string[]) {
  const result = await execFileAsync('curl', ['-sS', ...args], {
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  })
  return result.stdout
}

function printRaw(label: string, raw: string) {
  console.log(`--- ${label} ---`)
  console.log(redact(raw).trimEnd())
}

async function cookieJar(context: BrowserContext, dir: string, name: string) {
  const jar = join(dir, name)
  const cookies = await context.cookies()
  const lines = ['# Netscape HTTP Cookie File']
  for (const cookie of cookies) {
    lines.push(
      [
        cookie.domain,
        cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
        cookie.path,
        cookie.secure ? 'TRUE' : 'FALSE',
        String(
          cookie.expires > 0
            ? Math.floor(cookie.expires)
            : Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        ),
        cookie.name,
        cookie.value,
      ].join('\t'),
    )
  }
  await writeFile(jar, `${lines.join('\n')}\n`)
  return jar
}

async function signUp(context: BrowserContext, name: string, email: string) {
  let response = await context.request.post(
    `${BASE_URL}/api/auth/sign-up/email`,
    {
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
      data: { name, email, password: PASSWORD },
    },
  )
  for (
    let attempt = 0;
    attempt < 3 && response.status() === 429;
    attempt += 1
  ) {
    const retryAfter = Number(response.headers()['x-retry-after'] ?? '10')
    const seconds = Number.isFinite(retryAfter) ? retryAfter + 1 : 11
    console.log(`signup_status=429 retry_after=${seconds}`)
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    response = await context.request.post(
      `${BASE_URL}/api/auth/sign-up/email`,
      {
        headers: { origin: BASE_URL, 'content-type': 'application/json' },
        data: { name, email, password: PASSWORD },
      },
    )
  }
  const body = await response.text()
  printRaw(
    `sign-up ${name}`,
    `HTTP ${response.status()}\n${headerBlock(response)}\n${body}`,
  )
  if (response.status() !== 200)
    throw new Error(`sign-up ${name} status ${response.status()}`)
  const parsed = JSON.parse(body) as {
    user?: { id?: string; email?: string; name?: string }
  }
  const id = parsed.user?.id
  if (!id) throw new Error('sign-up missing user id')
  console.log(
    `signup_user id=${id} email=${parsed.user?.email} name=${parsed.user?.name}`,
  )
  return id
}

function headerBlock(response: { headers: () => Record<string, string> }) {
  return Object.entries(response.headers())
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

async function signIn(
  context: BrowserContext,
  email: string,
  password: string,
  allowFailure = false,
) {
  let response = await context.request.post(
    `${BASE_URL}/api/auth/sign-in/email`,
    {
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
      data: { email, password },
    },
  )
  for (
    let attempt = 0;
    attempt < 3 && response.status() === 429;
    attempt += 1
  ) {
    const retryAfter = Number(response.headers()['x-retry-after'] ?? '10')
    const seconds = Number.isFinite(retryAfter) ? retryAfter + 1 : 11
    console.log(`signin_status=429 retry_after=${seconds}`)
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    response = await context.request.post(
      `${BASE_URL}/api/auth/sign-in/email`,
      {
        headers: { origin: BASE_URL, 'content-type': 'application/json' },
        data: { email, password },
      },
    )
  }
  const body = await response.text()
  printRaw(
    `sign-in ${email}`,
    `HTTP ${response.status()}\n${headerBlock(response)}\n${body}`,
  )
  if (response.status() !== 200 && !allowFailure)
    throw new Error(`sign-in status ${response.status()}`)
  return response.status()
}

async function spaceIdFromHome(context: BrowserContext) {
  const response = await context.request.get(`${BASE_URL}/`, {
    maxRedirects: 0,
  })
  const location = response.headers()['location'] ?? ''
  printRaw('GET /', `HTTP ${response.status()}\nlocation: ${location}`)
  const match = location.match(/\/s\/([^/?]+)/)
  if (!match)
    throw new Error(
      `home did not redirect to a space: ${response.status()} ${location}`,
    )
  return match[1]
}

function isAppServerFn(url: string) {
  return new URL(url).pathname.startsWith('/_serverFn/')
}

async function createPage(page: Page) {
  const previous = page.url()
  const seen: string[] = []
  page.on('response', (response) => {
    const url = response.url()
    if (!isAppServerFn(url)) return
    const parsed = new URL(url)
    seen.push(
      `${response.request().method()} ${response.status()} ${parsed.pathname}`,
    )
  })
  await page.goto(previous, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.waitForFunction((href) => window.location.href !== href, previous)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').waitFor()
  const url = new URL(page.url())
  const pageId = url.pathname.split('/').pop() ?? ''
  console.log(`created_page url_path=${url.pathname} page_id=${pageId}`)
  console.log('server_fn_while_creating')
  for (const line of seen) console.log(line)
  return pageId
}

function libpqEnv(): NodeJS.ProcessEnv {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is required')
  assertLocalDatabaseUrl(raw)
  const url = new URL(raw)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  }
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  return env
}

async function psql(sql: string) {
  const env = libpqEnv()
  try {
    const result = await execFileAsync(
      'psql',
      ['-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
      {
        env,
        maxBuffer: 2 * 1024 * 1024,
      },
    )
    return result.stdout.trimEnd()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'psql failed'
    const secret = env.PGPASSWORD ?? ''
    throw new Error(
      redact(secret ? message.split(secret).join('[redacted]') : message),
    )
  }
}

async function userSnapshot(userId: string) {
  const userRow = await psql(
    `SELECT id, name, email, email_verified, coalesce(image,'(null)'), created_at, updated_at, must_change_password FROM "user" WHERE id = '${userId}'`,
  )
  const accountRow = await psql(
    `SELECT provider_id, length(password), md5(password), updated_at FROM account WHERE user_id = '${userId}' ORDER BY provider_id`,
  )
  const sessions = await psql(
    `SELECT count(*) FROM session WHERE user_id = '${userId}'`,
  )
  console.log(
    'user_row id|name|email|email_verified|image|created_at|updated_at|must_change_password',
  )
  console.log(userRow)
  console.log(
    'account_row provider_id|password_len|password_hash_md5|updated_at',
  )
  console.log(accountRow)
  console.log(`session_count=${sessions}`)
  return { userRow, accountRow, sessions }
}

function diffSnapshots(
  before: { userRow: string; accountRow: string },
  after: { userRow: string; accountRow: string },
) {
  const userBefore = before.userRow.split('|')
  const userAfter = after.userRow.split('|')
  const labels = [
    'id',
    'name',
    'email',
    'email_verified',
    'image',
    'created_at',
    'updated_at',
    'must_change_password',
  ]
  console.log('user_diff')
  const changed: string[] = []
  labels.forEach((label, index) => {
    const same = userBefore[index] === userAfter[index]
    console.log(
      `${label} ${same ? 'SAME' : `CHANGED ${userBefore[index]} -> ${userAfter[index]}`}`,
    )
    if (label === 'must_change_password') {
      if (userAfter[index] !== 't') changed.push('must_change_password')
      return
    }
    if (!same) changed.push(label)
  })
  const accountBefore = before.accountRow.split('|')
  const accountAfter = after.accountRow.split('|')
  const accountLabels = [
    'provider_id',
    'password_len',
    'password_hash_md5',
    'updated_at',
  ]
  console.log('account_diff')
  accountLabels.forEach((label, index) => {
    const same = accountBefore[index] === accountAfter[index]
    console.log(`${label} ${same ? 'SAME' : 'CHANGED'}`)
    if (label === 'password_hash_md5') {
      if (same) changed.push('password_hash_unchanged')
      return
    }
    if (!same) changed.push(label)
  })
  console.log(`user_fields_unchanged=${changed.length === 0}`)
  if (changed.length > 0) {
    throw new Error(`reset changed ${changed.join(',')}`)
  }
}

async function dumpCurl(label: string, args: string[]) {
  console.log(
    `$ curl ${args.map((arg) => (arg.startsWith('-') || arg.startsWith('http') ? arg : '<redacted-or-flag>')).join(' ')}`,
  )
  const raw = await curl(args)
  printRaw(label, raw)
  return {
    status: raw.match(/^HTTP\/\S+\s+(\d+)/m)?.[1] ?? '',
    location: raw.match(/^location:\s*(\S+)/im)?.[1] ?? '',
  }
}

async function fail1(dir: string) {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const a = await browser.newContext()
  const b = await browser.newContext()
  const aEmail = `ada.${stamp}@example.com`
  const bEmail = `bea.${stamp}@example.com`
  await signUp(a, 'Ada', aEmail)
  await signUp(b, 'Bea', bEmail)
  const aSpace = await spaceIdFromHome(a)
  const bSpace = await spaceIdFromHome(b)
  console.log(`A_SPACE=${aSpace}`)
  console.log(`B_SPACE=${bSpace}`)
  const page = await a.newPage()
  await page.goto(`${BASE_URL}/s/${aSpace}`, { waitUntil: 'networkidle' })
  const pageId = await createPage(page)
  const serverFnUrls = new Set<string>()
  page.on('request', (request) => {
    if (isAppServerFn(request.url()))
      serverFnUrls.add(`${request.method()} ${request.url()}`)
  })
  await page.locator('#page-title').fill('Ada private title')
  await page.locator('#page-title').blur()
  await page.locator('.doc-editor').click()
  await page.keyboard.type('Ada private body')
  let before = ''
  for (let attempt = 0; attempt < 25; attempt += 1) {
    before = await psql(
      `SELECT title || '|' || coalesce(body_text, '') FROM page WHERE id = '${pageId}'`,
    )
    if (before === 'Ada private title|Ada private body') break
    await page.waitForTimeout(200)
  }
  console.log(`page_before=${before}`)

  const aJar = await cookieJar(a, dir, 'a.txt')
  const bJar = await cookieJar(b, dir, 'b.txt')
  const pageUrl = `${BASE_URL}/s/${aSpace}/p/${pageId}`
  const spaceUrl = `${BASE_URL}/s/${aSpace}`
  const ownOpen = await dumpCurl('A opens own page', [
    '-D',
    '-',
    '-o',
    join(dir, 'a-open'),
    '-b',
    aJar,
    pageUrl,
  ])
  const otherOpen = await dumpCurl('B opens A page', [
    '-D',
    '-',
    '-o',
    join(dir, 'open-body'),
    '-b',
    bJar,
    pageUrl,
  ])
  const openText = await readFile(join(dir, 'open-body'), 'utf8')
  console.log(`open_has_page_not_found=${openText.includes('Page not found.')}`)

  const savePayload = join(dir, 'save.json')
  await writeFile(
    savePayload,
    JSON.stringify({
      pageId,
      title: 'stolen',
      body: { type: 'doc', content: [] },
    }),
  )
  const otherSave = await dumpCurl('B saves A page', [
    '-D',
    '-',
    '-o',
    join(dir, 'save-body'),
    '-b',
    bJar,
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `origin: ${BASE_URL}`,
    '--data-binary',
    `@${savePayload}`,
    `${BASE_URL}/api/pages/save`,
  ])
  console.log(
    `save_body=${(await readFile(join(dir, 'save-body'), 'utf8')).trim()}`,
  )
  const after = await psql(
    `SELECT title || '|' || body_text FROM page WHERE id = '${pageId}'`,
  )
  console.log(`page_after=${after}`)
  console.log(`content_unchanged=${before === after}`)

  const otherTree = await dumpCurl('B lists A space tree', [
    '-D',
    '-',
    '-o',
    join(dir, 'tree-body'),
    '-b',
    bJar,
    spaceUrl,
  ])
  const treeText = await readFile(join(dir, 'tree-body'), 'utf8')
  console.log(`tree_has_page_not_found=${treeText.includes('Page not found.')}`)

  const bPage = await b.newPage()
  await bPage.goto(`${BASE_URL}/s/${bSpace}`, { waitUntil: 'networkidle' })
  const ownHtml = await bPage.content()
  console.log(`B_tree_contains_A_page=${ownHtml.includes(pageId)}`)
  console.log(
    `B_tree_contains_A_title=${ownHtml.includes('Ada private title')}`,
  )

  let replay = 0
  for (const entry of serverFnUrls) {
    const [method, target] = entry.split(' ', 2)
    if (method !== 'GET' || !target.includes('payload=')) continue
    replay += 1
    const args = [
      '-D',
      '-',
      '-o',
      join(dir, `replay-${replay}.body`),
      '-b',
      bJar,
      '-H',
      'x-tsr-serverFn: true',
      '-H',
      `origin: ${BASE_URL}`,
    ]
    if (method !== 'GET') args.push('-X', method)
    args.push(target)
    await dumpCurl(`B replays ${method} server function`, args)
    console.log(
      `replay_body=${redact(await readFile(join(dir, `replay-${replay}.body`), 'utf8')).slice(0, 300)}`,
    )
  }

  await browser.close()
  if (ownOpen.status !== '200')
    throw new Error(`owner open status ${ownOpen.status}`)
  if (otherOpen.status !== '404' || !openText.includes('Page not found.')) {
    throw new Error(`other user open status ${otherOpen.status}`)
  }
  if (otherSave.status !== '404')
    throw new Error(`other user save status ${otherSave.status}`)
  if (before !== after) throw new Error('A page content changed')
  if (otherTree.status !== '404' || !treeText.includes('Page not found.')) {
    throw new Error(`other user tree status ${otherTree.status}`)
  }
  if (ownHtml.includes(pageId) || ownHtml.includes('Ada private title')) {
    throw new Error('B tree lists A page')
  }
}

async function fail2(dir: string) {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext()
  const stamp = Date.now()
  await signUp(context, 'Signed', `signed.${stamp}@example.com`)
  const space = await spaceIdFromHome(context)
  const page = await context.newPage()
  await page.goto(`${BASE_URL}/s/${space}`, { waitUntil: 'networkidle' })
  const fnUrls = new Set<string>()
  page.on('request', (request) => {
    if (!isAppServerFn(request.url())) return
    fnUrls.add(`${request.method()} ${request.url()}`)
  })
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.locator('#page-title').waitFor()
  console.log('observed_server_fns')
  for (const line of fnUrls) console.log(line.split('?')[0])
  const getFn = [...fnUrls].find(
    (line) => line.startsWith('GET ') && line.includes('payload='),
  )
  await browser.close()

  const signedOutPage = await dumpCurl('signed-out page', [
    '-D',
    '-',
    '-o',
    '/dev/null',
    `${BASE_URL}/s/${space}/p/missing`,
  ])
  const payload = join(dir, 'anon-save.json')
  await writeFile(
    payload,
    JSON.stringify({
      pageId: 'missing',
      title: 'x',
      body: { type: 'doc', content: [] },
    }),
  )
  const signedOutApi = await dumpCurl('signed-out page API', [
    '-D',
    '-',
    '-o',
    join(dir, 'anon-api'),
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `origin: ${BASE_URL}`,
    '--data-binary',
    `@${payload}`,
    `${BASE_URL}/api/pages/save`,
  ])
  console.log(
    `api_body=${(await readFile(join(dir, 'anon-api'), 'utf8')).trim()}`,
  )
  if (!getFn) throw new Error('no signed-in server function was observed')
  const target = getFn.slice(4)
  const signedOutFn = await dumpCurl('signed-out server function', [
    '-D',
    '-',
    '-o',
    join(dir, 'anon-fn'),
    '-H',
    'x-tsr-serverFn: true',
    '-H',
    `origin: ${BASE_URL}`,
    target,
  ])
  console.log(
    `server_fn_body=${redact(await readFile(join(dir, 'anon-fn'), 'utf8')).slice(0, 400)}`,
  )
  if (
    signedOutPage.status !== '307' ||
    !signedOutPage.location.includes('/sign-in')
  ) {
    throw new Error(
      `signed-out page status ${signedOutPage.status} location ${signedOutPage.location}`,
    )
  }
  if (signedOutApi.status !== '401')
    throw new Error(`signed-out api status ${signedOutApi.status}`)
  if (signedOutFn.status !== '401')
    throw new Error(`signed-out server function status ${signedOutFn.status}`)
}

const HASH_SHAPE = /^[0-9a-f]{32}:[0-9a-f]{128}$/

type CapturedFn = {
  method: string
  url: string
  body: string | null
  contentType: string
}

function requireAdmin() {
  if (ADMIN_SECRET.length < 32)
    throw new Error('ADMIN_API_SECRET unset or short')
}

function randomPassword() {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(24)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

async function writeTrace(name: string, value: string) {
  const trace = process.env.VERIFY_TRACE_DIR
  if (!trace) return
  await writeFile(join(trace, name), value, { mode: 0o600 })
}

function assertAbsent(label: string, text: string, plains: string[]) {
  const present = plains.some(
    (plain) => plain.length > 0 && (text === plain || text.includes(plain)),
  )
  console.log(`${label}_plaintext=${present ? 'present' : 'absent'}`)
  if (present) throw new Error(`${label} contains plaintext`)
}

function assertPasswordHash(stored: string, plains: string[]) {
  const shape = stored.length === 161 && HASH_SHAPE.test(stored)
  console.log(`password_len=${stored.length}`)
  console.log(`password_hash_shape=${shape}`)
  if (!shape)
    throw new Error('stored password is not a 161-character scrypt hash')
  assertAbsent('password_hash', stored, plains)
}

async function storedPassword(userId: string) {
  const stored = await psql(
    `SELECT password FROM account WHERE user_id = '${userId}' AND provider_id = 'credential'`,
  )
  if (!stored || stored.includes('\n'))
    throw new Error('expected one credential password hash')
  return stored
}

async function assertRowsLackPlaintext(userId: string, plains: string[]) {
  const userText = await psql(
    `SELECT id || '|' || name || '|' || email || '|' || email_verified::text || '|' || coalesce(image, '') || '|' || created_at::text || '|' || updated_at::text || '|' || must_change_password::text FROM "user" WHERE id = '${userId}'`,
  )
  const accountText = await psql(
    `SELECT id || '|' || account_id || '|' || provider_id || '|' || user_id || '|' || coalesce(access_token, '') || '|' || coalesce(refresh_token, '') || '|' || coalesce(id_token, '') || '|' || coalesce(scope, '') || '|' || coalesce(password, '') || '|' || created_at::text || '|' || updated_at::text || '|' || coalesce(access_token_expires_at::text, '') || '|' || coalesce(refresh_token_expires_at::text, '') FROM account WHERE user_id = '${userId}'`,
  )
  assertAbsent('user_row', userText, plains)
  assertAbsent('account_row', accountText, plains)
}

async function assertAudit(userId: string, expected: number) {
  const raw = await psql(
    `SELECT id || '|' || action || '|' || target_user_id || '|' || coalesce(caller_ip, '') || '|' || created_at FROM admin_audit WHERE target_user_id = '${userId}' ORDER BY created_at`,
  )
  console.log('audit_row id|action|target_user_id|caller_ip|created_at')
  console.log(raw)
  const lines = raw.split('\n').filter((line) => line.length > 0)
  console.log(`audit_rows=${lines.length}`)
  if (lines.length !== expected)
    throw new Error(`admin_audit row count ${lines.length}`)
  for (const line of lines) {
    const [id, action, target, caller, created] = line.split('|')
    if (
      !id ||
      action !== 'reset_password' ||
      target !== userId ||
      !caller ||
      !created
    ) {
      throw new Error(
        'admin_audit row is missing action, target, caller IP, or time',
      )
    }
    if (caller === '6.6.6.6')
      throw new Error('audit stored the forwarded address')
  }
  await writeTrace('audit_row', `${raw}\n`)
  return raw
}

async function postReset(
  dir: string,
  email: string,
  fields: Record<string, string>,
) {
  const file = join(dir, `reset-${Date.now()}.json`)
  await writeFile(file, JSON.stringify({ email, ...fields }))
  const raw = await curl([
    '-D',
    '-',
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `authorization: Bearer ${ADMIN_SECRET}`,
    '-H',
    'x-forwarded-for: 6.6.6.6',
    '--data-binary',
    `@${file}`,
    `${BASE_URL}/api/admin/reset-password`,
  ])
  printRaw('admin reset', raw)
  const status = raw.match(/^HTTP\/\S+\s+(\d+)/m)?.[1] ?? ''
  const temporary = raw.match(/"temporaryPassword":"([^"]+)"/)?.[1] ?? ''
  console.log(`reset_status=${status}`)
  console.log(`temporaryPassword_len=${temporary.length}`)
  return { status, temporary }
}

function requireTemp(status: string, temporary: string) {
  if (status !== '200' || temporary.length !== 24)
    throw new Error('reset did not return a temporary password')
}

async function captureServerFns(context: BrowserContext) {
  const space = await spaceIdFromHome(context)
  const page = await context.newPage()
  const seen: CapturedFn[] = []
  page.on('request', (request) => {
    if (!isAppServerFn(request.url())) return
    seen.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
      contentType: request.headers()['content-type'] ?? '',
    })
  })
  await page.goto(`${BASE_URL}/s/${space}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').waitFor()
  const getFn = seen.find(
    (item) => item.method === 'GET' && item.url.includes('payload='),
  )
  const postFn = seen.find((item) => item.method === 'POST' && item.body)
  console.log(`captured_server_fn_count=${seen.length}`)
  if (!getFn || !postFn)
    throw new Error('missing GET or POST server function')
  console.log(`captured_get=${new URL(getFn.url).pathname}`)
  console.log(`captured_post=${new URL(postFn.url).pathname}`)
  await page.close()
  return { getFn, postFn }
}

async function signInToSetPassword(
  page: Page,
  email: string,
  password: string,
) {
  const paths: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    if (frame.url() === 'about:blank') return
    let path = ''
    try {
      path = new URL(frame.url()).pathname
    } catch {
      return
    }
    if (path === '/sign-in') return
    paths.push(path)
  })
  await page.goto(`${BASE_URL}/sign-in`, { waitUntil: 'networkidle' })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
  await page.waitForURL((url) => url.pathname === '/set-password', {
    timeout: 15000,
  })
  const landed = new URL(page.url()).pathname
  const earlier = paths.filter((path) => path !== '/set-password')
  console.log(`landed_path=${landed}`)
  console.log(`earlier_paths=${earlier.join(' ') || 'none'}`)
  console.log(`first_path=${earlier[0] ?? landed}`)
  if (landed !== '/set-password')
    throw new Error(`landed on ${landed}`)
  if (earlier.length > 0)
    throw new Error(`visited ${earlier[0]} before /set-password`)
}

async function replayServerFn(
  dir: string,
  jar: string,
  fn: CapturedFn,
  label: string,
) {
  const args = [
    '-D',
    '-',
    '-o',
    join(dir, `${label.replace(/\s+/g, '-')}.out`),
    '-b',
    jar,
    '-H',
    'x-tsr-serverFn: true',
    '-H',
    `origin: ${BASE_URL}`,
  ]
  if (fn.contentType) args.push('-H', `content-type: ${fn.contentType}`)
  if (fn.method !== 'GET') {
    args.push('-X', fn.method)
    if (fn.body) {
      const payload = join(dir, `${label.replace(/\s+/g, '-')}.req`)
      await writeFile(payload, fn.body)
      args.push('--data-binary', `@${payload}`)
    }
  }
  args.push(fn.url)
  const result = await dumpCurl(label, args)
  return result.status
}

async function changePassword(page: Page, userId: string) {
  await waitForClient(page)
  await page.getByRole('heading', { name: 'Set a new password' }).waitFor()
  const fnStatuses: string[] = []
  page.on('response', (response) => {
    const url = response.url()
    if (!isAppServerFn(url) && !new URL(url).pathname.startsWith('/api/auth/'))
      return
    fnStatuses.push(
      `${response.request().method()} ${response.status()} ${new URL(url).pathname}`,
    )
  })
  await page.locator('#password').fill(NEW_PASSWORD)
  await page.locator('#confirm').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Save password' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/set-password'), {
    timeout: 15000,
  })
  console.log('change_password_responses')
  for (const line of fnStatuses) console.log(line)
  const changedPath = new URL(page.url()).pathname
  console.log(`after_change_password_path=${changedPath}`)
  const unlocked = await psql(
    `SELECT must_change_password FROM "user" WHERE id = '${userId}'`,
  )
  console.log(`must_change_password_after_change=${unlocked}`)
  if (changedPath.startsWith('/set-password'))
    throw new Error('change password did not leave /set-password')
  if (unlocked !== 'f')
    throw new Error(`must_change_password after change ${unlocked}`)
  const stored = await storedPassword(userId)
  assertPasswordHash(stored, [NEW_PASSWORD, PASSWORD])
  await writeTrace('new_password', NEW_PASSWORD)
}

async function signOut(context: BrowserContext, dir: string) {
  const fresh = await cookieJar(context, dir, 'after-change.txt')
  const emptyBody = join(dir, 'empty.json')
  await writeFile(emptyBody, '{}')
  const signOutResult = await dumpCurl('sign-out', [
    '-D',
    '-',
    '-o',
    join(dir, 'signout-body'),
    '-b',
    fresh,
    '-c',
    fresh,
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `origin: ${BASE_URL}`,
    '--data-binary',
    `@${emptyBody}`,
    `${BASE_URL}/api/auth/sign-out`,
  ])
  console.log(
    `signout_body=${redact((await readFile(join(dir, 'signout-body'), 'utf8')).trim())}`,
  )
  const sessionAfter = await dumpCurl('get-session after sign-out', [
    '-D',
    '-',
    '-o',
    join(dir, 'session-body'),
    '-b',
    fresh,
    `${BASE_URL}/api/auth/get-session`,
  ])
  const sessionBody = redact(
    (await readFile(join(dir, 'session-body'), 'utf8')).trim(),
  )
  console.log(`session_body=${sessionBody}`)
  if (signOutResult.status !== '200')
    throw new Error(`sign-out status ${signOutResult.status}`)
  if (sessionAfter.status !== '200' || !sessionBody.includes('null'))
    throw new Error('session still present after sign-out')
}

async function createLockedUser(name: string) {
  requireAdmin()
  const email = `lock.${Date.now()}@example.com`
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext()
  const userId = await signUp(context, name, email)
  return { browser, context, email, userId }
}

async function assertResetStorage(
  userId: string,
  before: { userRow: string; accountRow: string },
  plains: string[],
  auditRows: number,
) {
  const after = await userSnapshot(userId)
  diffSnapshots(before, after)
  if (after.sessions !== '0')
    throw new Error(`sessions after reset ${after.sessions}`)
  const stored = await storedPassword(userId)
  assertPasswordHash(stored, plains)
  await assertAudit(userId, auditRows)
  await assertRowsLackPlaintext(userId, plains)
}

async function fail5c(dir: string) {
  const { browser, email, userId } = await createLockedUser('Lock Name')
  const before = await userSnapshot(userId)
  await browser.close()
  const reset = await postReset(dir, email, {})
  requireTemp(reset.status, reset.temporary)
  await writeTrace('temp_password', reset.temporary)
  await assertResetStorage(
    userId,
    before,
    [reset.temporary, PASSWORD, NEW_PASSWORD],
    1,
  )
  console.log('sessions_ended=true')
}

async function fail5d(dir: string) {
  const { browser, email, userId } = await createLockedUser('Lock Name')
  const before = await userSnapshot(userId)
  await browser.close()
  const reset = await postReset(dir, email, {})
  requireTemp(reset.status, reset.temporary)
  await writeTrace('temp_password', reset.temporary)
  await assertResetStorage(
    userId,
    before,
    [reset.temporary, PASSWORD, NEW_PASSWORD],
    1,
  )
  const locked = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const lockedContext = await locked.newContext()
  const page = await lockedContext.newPage()
  await signInToSetPassword(page, email, reset.temporary)
  await changePassword(page, userId)
  await signOut(lockedContext, dir)
  await locked.close()
}

async function fail5f(dir: string) {
  const supplied = randomPassword()
  await writeTrace('supplied_password', supplied)
  const { browser, email, userId } = await createLockedUser('Lock Name')
  const before = await userSnapshot(userId)
  await browser.close()

  const first = await postReset(dir, email, { password: supplied })
  requireTemp(first.status, first.temporary)
  if (first.temporary === supplied)
    throw new Error('server returned the supplied password')
  console.log('supplied_password_field=ignored')
  await writeTrace('temp_password', first.temporary)
  const plains = [first.temporary, supplied, PASSWORD, NEW_PASSWORD]
  await assertResetStorage(userId, before, plains, 1)

  const probe = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const probeContext = await probe.newContext()
  const suppliedStatus = await signIn(probeContext, email, supplied, true)
  console.log(`supplied_sign_in_status=${suppliedStatus}`)
  console.log(`supplied_password_verifies=${suppliedStatus === 200}`)
  if (suppliedStatus === 200)
    throw new Error('supplied password verified')
  await probe.close()

  const second = await postReset(dir, email, {})
  requireTemp(second.status, second.temporary)
  const differs = second.temporary !== first.temporary
  console.log(`second_temporary_differs=${differs}`)
  console.log(`second_temporary_len=${second.temporary.length}`)
  if (!differs)
    throw new Error('second reset returned the same temporary password')
  await writeTrace('temp_password_2', second.temporary)
  await assertResetStorage(userId, before, [...plains, second.temporary], 2)

  const locked = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const lockedContext = await locked.newContext()
  const page = await lockedContext.newPage()
  await signInToSetPassword(page, email, second.temporary)
  await changePassword(page, userId)
  await signOut(lockedContext, dir)
  await locked.close()
}

async function fail5g(dir: string) {
  const { browser, context, email, userId } = await createLockedUser(
    'Lock Name',
  )
  const captured = await captureServerFns(context)
  const before = await userSnapshot(userId)
  await browser.close()
  const reset = await postReset(dir, email, {})
  requireTemp(reset.status, reset.temporary)
  await writeTrace('temp_password', reset.temporary)
  await assertResetStorage(
    userId,
    before,
    [reset.temporary, PASSWORD, NEW_PASSWORD],
    1,
  )

  const locked = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const lockedContext = await locked.newContext()
  const page = await lockedContext.newPage()
  await signInToSetPassword(page, email, reset.temporary)
  const lockedJar = await cookieJar(lockedContext, dir, 'locked.txt')
  const getStatus = await replayServerFn(
    dir,
    lockedJar,
    captured.getFn,
    'locked GET server function',
  )
  const postStatus = await replayServerFn(
    dir,
    lockedJar,
    captured.postFn,
    'locked POST server function',
  )
  console.log(`locked_get_server_fn=${getStatus}`)
  console.log(`locked_post_server_fn=${postStatus}`)
  if (getStatus !== '403')
    throw new Error(`locked GET server function ${getStatus}`)
  if (postStatus !== '403')
    throw new Error(`locked POST server function ${postStatus}`)

  const savePayload = join(dir, 'locked-save.json')
  await writeFile(
    savePayload,
    JSON.stringify({
      pageId: 'missing-page',
      title: 'x',
      body: { type: 'doc', content: [] },
    }),
  )
  const lockedSave = await dumpCurl('locked page API', [
    '-D',
    '-',
    '-o',
    join(dir, 'locked-api'),
    '-b',
    lockedJar,
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `origin: ${BASE_URL}`,
    '--data-binary',
    `@${savePayload}`,
    `${BASE_URL}/api/pages/save`,
  ])
  console.log(
    `locked_api_body=${(await readFile(join(dir, 'locked-api'), 'utf8')).trim()}`,
  )
  const updatePayload = join(dir, 'update.json')
  await writeFile(
    updatePayload,
    JSON.stringify({ name: 'Renamed while locked' }),
  )
  const lockedUpdate = await dumpCurl('locked update-user', [
    '-D',
    '-',
    '-o',
    join(dir, 'update-body'),
    '-b',
    lockedJar,
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `origin: ${BASE_URL}`,
    '--data-binary',
    `@${updatePayload}`,
    `${BASE_URL}/api/auth/update-user`,
  ])
  console.log(
    `update_body=${(await readFile(join(dir, 'update-body'), 'utf8')).trim()}`,
  )
  const nameAfter = await psql(`SELECT name FROM "user" WHERE id = '${userId}'`)
  console.log(`name_after_update_user=${nameAfter}`)
  if (lockedSave.status !== '403')
    throw new Error(`locked save status ${lockedSave.status}`)
  if (lockedUpdate.status !== '403')
    throw new Error(`locked update-user status ${lockedUpdate.status}`)
  if (nameAfter !== 'Lock Name')
    throw new Error(`name changed while locked: ${nameAfter}`)

  await changePassword(page, userId)
  await signOut(lockedContext, dir)
  await locked.close()
}

async function fail5h(dir: string) {
  if (ADMIN_SECRET.length < 32)
    throw new Error('ADMIN_API_SECRET unset or short')
  const payload = join(dir, 'wrong.json')
  await writeFile(
    payload,
    JSON.stringify({ email: `missing.${Date.now()}@example.com` }),
  )
  const statuses: string[] = []
  for (let i = 0; i < 6; i += 1) {
    const raw = await curl([
      '-D',
      '-',
      '-o',
      join(dir, `xff-${i}`),
      '-X',
      'POST',
      '-H',
      'content-type: application/json',
      '-H',
      'authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      '-H',
      `x-forwarded-for: 6.6.6.${i}`,
      '--data-binary',
      `@${payload}`,
      `${BASE_URL}/api/admin/reset-password`,
    ])
    const status = raw.match(/^HTTP\/\S+\s+(\d+)/m)?.[1] ?? ''
    const body = (await readFile(join(dir, `xff-${i}`), 'utf8')).trim()
    statuses.push(status)
    console.log(`attempt_${i + 1}=${status} body=${body}`)
  }
  const fresh =
    statuses.slice(0, 5).every((status) => status === '401') &&
    statuses[5] === '429'
  if (!fresh) throw new Error(`rate limit statuses ${statuses.join(',')}`)
}

async function main() {
  const cmd = process.argv[2] ?? 'all'
  const dir = await mkdtemp(join(tmpdir(), 'atlas-evidence-'))
  try {
    if (cmd === 'fail1' || cmd === 'all') await fail1(dir)
    if (cmd === 'fail2' || cmd === 'all') await fail2(dir)
    if (cmd === 'fail5c') await fail5c(dir)
    if (cmd === 'fail5d') await fail5d(dir)
    if (cmd === 'fail5' || cmd === 'fail5f' || cmd === 'all') await fail5f(dir)
    if (cmd === 'fail5g') await fail5g(dir)
    if (cmd === 'fail5h' || cmd === 'all') await fail5h(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(
    redact(
      error instanceof Error
        ? (error.stack ?? error.message)
        : 'http evidence failed',
    ),
  )
  process.exit(1)
})
