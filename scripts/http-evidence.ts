import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type BrowserContext, type Page } from 'playwright'

const execFileAsync = promisify(execFile)
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3010').replace(
  /\/$/,
  '',
)
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'evidence-password-ok'
const ADMIN_SECRET = process.env.ADMIN_API_SECRET ?? ''

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
  const response = await context.request.post(
    `${BASE_URL}/api/auth/sign-up/email`,
    {
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
      data: { name, email, password: PASSWORD },
    },
  )
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
) {
  const response = await context.request.post(
    `${BASE_URL}/api/auth/sign-in/email`,
    {
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
      data: { email, password },
    },
  )
  const body = await response.text()
  printRaw(
    `sign-in ${email}`,
    `HTTP ${response.status()}\n${headerBlock(response)}\n${body}`,
  )
  if (response.status() !== 200)
    throw new Error(`sign-in status ${response.status()}`)
  return body
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
  const url = new URL(raw)
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('refusing non-local DATABASE_URL')
  }
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
      { env, maxBuffer: 2 * 1024 * 1024 },
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
  labels.forEach((label, index) => {
    const same = userBefore[index] === userAfter[index]
    console.log(
      `${label} ${same ? 'SAME' : `CHANGED ${userBefore[index]} -> ${userAfter[index]}`}`,
    )
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
  })
}

async function dumpCurl(label: string, args: string[]) {
  console.log(
    `$ curl ${args.map((arg) => (arg.startsWith('-') || arg.startsWith('http') ? arg : '<redacted-or-flag>')).join(' ')}`,
  )
  const raw = await curl(args)
  printRaw(label, raw)
  const status = raw.match(/^HTTP\/\S+\s+(\d+)/m)?.[1] ?? ''
  return status
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
  await dumpCurl('A opens own page', [
    '-D',
    '-',
    '-o',
    join(dir, 'a-open'),
    '-b',
    aJar,
    pageUrl,
  ])
  await dumpCurl('B opens A page', [
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
  await dumpCurl('B saves A page', [
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

  await dumpCurl('B lists A space tree', [
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
  if (before !== after) throw new Error('A page content changed')
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

  await dumpCurl('signed-out page', [
    '-D',
    '-',
    '-o',
    '/dev/null',
    `${BASE_URL}/s/${space}/p/missing`,
  ])
  const payload = join(dir, 'anon-save.json')
  await writeFile(
    payload,
    JSON.stringify({ pageId: 'missing', title: 'x', body: {} }),
  )
  await dumpCurl('signed-out page API', [
    '-D',
    '-',
    '-o',
    join(dir, 'anon-api'),
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${payload}`,
    `${BASE_URL}/api/pages/save`,
  ])
  console.log(
    `api_body=${(await readFile(join(dir, 'anon-api'), 'utf8')).trim()}`,
  )
  if (getFn) {
    const target = getFn.slice(4)
    await dumpCurl('signed-out server function', [
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
  }
}

async function fail5(dir: string) {
  if (ADMIN_SECRET.length < 32)
    throw new Error('ADMIN_API_SECRET unset or short')
  const stamp = Date.now()
  const email = `lock.${stamp}@example.com`
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext()
  const userId = await signUp(context, 'Lock Name', email)
  const before = await userSnapshot(userId)
  const jar = await cookieJar(context, dir, 'lock.txt')
  await browser.close()

  const resetBody = join(dir, 'reset.json')
  await writeFile(resetBody, JSON.stringify({ email }))
  const resetRaw = await curl([
    '-D',
    '-',
    '-b',
    jar,
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-H',
    `authorization: Bearer ${ADMIN_SECRET}`,
    '-H',
    'x-forwarded-for: 6.6.6.6',
    '--data-binary',
    `@${resetBody}`,
    `${BASE_URL}/api/admin/reset-password`,
  ])
  printRaw('admin reset', resetRaw)
  const resetStatus = resetRaw.match(/^HTTP\/\S+\s+(\d+)/m)?.[1]
  const tempMatch = resetRaw.match(/"temporaryPassword":"([^"]+)"/)
  const temporary = tempMatch?.[1] ?? ''
  console.log(`reset_status=${resetStatus}`)
  console.log(`temporaryPassword_len=${temporary.length}`)
  if (resetStatus !== '200' || !temporary)
    throw new Error('reset did not return a temporary password')
  const after = await userSnapshot(userId)
  diffSnapshots(before, after)
  const audit = await psql(
    `SELECT action || '|' || target_user_id || '|' || caller_ip || '|' || created_at FROM admin_audit WHERE target_user_id = '${userId}'`,
  )
  console.log(`audit_row action|target_user_id|caller_ip|created_at`)
  console.log(audit)

  const locked = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const lockedContext = await locked.newContext()
  await signIn(lockedContext, email, temporary)
  const lockedJar = await cookieJar(lockedContext, dir, 'locked.txt')
  const pageId = 'missing-page'
  const savePayload = join(dir, 'locked-save.json')
  await writeFile(savePayload, JSON.stringify({ pageId, title: 'x', body: {} }))
  await dumpCurl('locked page API', [
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
  await dumpCurl('locked update-user', [
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

  const page = await lockedContext.newPage()
  const fnStatuses: string[] = []
  page.on('response', async (response) => {
    const url = response.url()
    if (!isAppServerFn(url) && !new URL(url).pathname.startsWith('/api/auth/'))
      return
    fnStatuses.push(
      `${response.request().method()} ${response.status()} ${new URL(url).pathname}`,
    )
  })
  await page.goto(`${BASE_URL}/set-password`, { waitUntil: 'networkidle' })
  await page.locator('#password').fill('new-password-ok')
  await page.locator('#confirm').fill('new-password-ok')
  await page.getByRole('button', { name: 'Save password' }).click()
  await page
    .waitForURL((url) => !url.pathname.startsWith('/set-password'), {
      timeout: 15000,
    })
    .catch(() => undefined)
  console.log('change_password_responses')
  for (const line of fnStatuses) console.log(line)
  console.log(`after_change_password_path=${new URL(page.url()).pathname}`)
  const unlocked = await psql(
    `SELECT must_change_password FROM "user" WHERE id = '${userId}'`,
  )
  console.log(`must_change_password_after_change=${unlocked}`)

  const fresh = await cookieJar(lockedContext, dir, 'after-change.txt')
  const emptyBody = join(dir, 'empty.json')
  await writeFile(emptyBody, '{}')
  await dumpCurl('sign-out', [
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
  await dumpCurl('get-session after sign-out', [
    '-D',
    '-',
    '-o',
    join(dir, 'session-body'),
    '-b',
    fresh,
    `${BASE_URL}/api/auth/get-session`,
  ])
  console.log(
    `session_body=${redact((await readFile(join(dir, 'session-body'), 'utf8')).trim())}`,
  )
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
    console.log(`attempt_${i + 1}=${status} body=${body}`)
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'all'
  const dir = await mkdtemp(join(tmpdir(), 'atlas-evidence-'))
  try {
    if (cmd === 'fail1' || cmd === 'all') await fail1(dir)
    if (cmd === 'fail2' || cmd === 'all') await fail2(dir)
    if (cmd === 'fail5' || cmd === 'all') await fail5(dir)
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
