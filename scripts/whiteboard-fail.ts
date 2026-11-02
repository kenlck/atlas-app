import { chromium, type Page } from 'playwright'
import { closeDb, getSql } from '../src/lib/db'
import { canonicalElements } from '../src/lib/drawing'
import {
  archivePage,
  createPage,
  listPageTree,
  type TreeNode,
} from '../src/lib/pages'
import { assertLocalBaseUrl, assertLocalDatabaseUrl, submitAuthForm } from './verify-local.ts'

const PASSWORD = 'whiteboard-recipe-pass'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function redact(text: string) {
  return text
    .replace(/atl_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(
      /better-auth\.session_token=[^;\s]+/g,
      'better-auth.session_token=[redacted]',
    )
    .replace(/("token"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("password"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, 1500)
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

let failed = false

function line(name: string, value: string | number | boolean) {
  console.log(`${name}=${value}`)
  return value
}

function expectLine(name: string, value: string | number | boolean, want: string | number | boolean) {
  line(name, value)
  if (value !== want) failed = true
}

function cookieHeader(response: globalThis.Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  return raw
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry.includes('='))
    .join('; ')
}

async function signUp(base: string, name: string) {
  const email = `${name}.${crypto.randomUUID()}@example.com`.toLowerCase()
  let response: globalThis.Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name, email, password: PASSWORD }),
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
  const body = JSON.parse(text) as { user?: { id?: string } }
  if (!body.user?.id) fail('signup_user=missing')
  return { cookie, email, id: body.user.id }
}

async function api(
  base: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: base,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

async function createToken(base: string, cookie: string, name: string) {
  const response = await api(base, cookie, 'POST', '/api/atlas/tokens', {
    name,
    scope: 'read_write',
    expiry: '90d',
  })
  if (response.status !== 201) fail(`create_token_status=${response.status}`)
  const body = JSON.parse(response.text) as { token?: string }
  if (!body.token) fail('create_token=missing')
  return body.token
}

async function personalSpaceId(userId: string) {
  const rows = await getSql()<{ id: string }[]>`
    select id from space where owner_user_id = ${userId} and kind = 'personal' limit 1
  `
  const id = rows[0]?.id
  if (!id) fail('personal_space=missing')
  return id
}

async function createTeam(base: string, cookie: string, name: string) {
  const response = await api(base, cookie, 'POST', '/api/atlas/teams', { name })
  if (response.status !== 201) fail(`create_team_status=${response.status}`)
  const body = JSON.parse(response.text) as { id?: string; spaceId?: string }
  if (!body.id || !body.spaceId) fail('create_team=missing')
  return { id: body.id, spaceId: body.spaceId }
}

async function invite(
  base: string,
  ownerCookie: string,
  teamId: string,
  email: string,
  memberCookie: string,
) {
  const lookup = await api(
    base,
    ownerCookie,
    'POST',
    `/api/atlas/teams/${teamId}/invites/lookup`,
    { email },
  )
  if (lookup.status !== 200) fail(`lookup_status=${lookup.status}`)
  const found = JSON.parse(lookup.text) as { user?: { id?: string } }
  if (!found.user?.id) fail('lookup_user=missing')
  const created = await api(base, ownerCookie, 'POST', `/api/atlas/teams/${teamId}/invites`, {
    userId: found.user.id,
  })
  if (created.status !== 201) fail(`invite_status=${created.status}`)
  const inviteBody = JSON.parse(created.text) as { id?: string }
  if (!inviteBody.id) fail('invite_id=missing')
  const accepted = await api(
    base,
    memberCookie,
    'POST',
    `/api/atlas/invites/${inviteBody.id}/accept`,
  )
  if (accepted.status !== 200) fail(`accept_status=${accepted.status}`)
  return found.user.id
}

const LABEL = 'roadmap'
const SECRET = 'secretneedle'

function elements() {
  return [
    { id: SECRET, type: 'rectangle', text: SECRET, x: 4, y: 6, width: 20, height: 10 },
    { id: 'label-1', type: 'text', text: LABEL, x: 8, y: 9 },
    { id: 'arrow-1', type: 'arrow', points: [[0, 0], [12, 4]] },
  ]
}

async function drawingRequest(
  base: string,
  method: string,
  path: string,
  options?: { cookie?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {}
  if (options?.cookie) headers.cookie = options.cookie
  if (options?.token) headers.authorization = `Bearer ${options.token}`
  if (options?.cookie) headers.origin = base
  let body: string | undefined
  if (options?.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  const response = await fetch(`${base}${path}`, { method, headers, body })
  const text = await response.text()
  return { status: response.status, text }
}

async function mcp(base: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const text = await response.text()
  const payload = JSON.parse(text) as {
    result?: { content?: Array<{ text?: string }> }
    error?: { message?: string }
  }
  return {
    status: response.status,
    error: payload.error?.message ?? '',
    data: JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as {
      body?: string
      title?: string
      updated_at?: string
      hits?: Array<{ id?: string }>
    },
  }
}

function treeIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...treeIds(node.children)])
}

async function browser() {
  return chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}

async function signUpUi(page: Page, base: string, name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const email = `${slug}.${crypto.randomUUID()}@example.com`
  await page.goto(`${base}/sign-up`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
  await page.locator('#name').fill(name)
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.locator('.app').waitFor()
}

async function openWhiteboard(page: Page) {
  await page.locator('.tree .new-page button').click()
  await page
    .locator('.tree .new-page')
    .getByRole('button', { name: 'Whiteboard', exact: true })
    .click()
  await page.locator('.excalidraw').waitFor({ timeout: 30_000 })
  await page.locator('#page-title').waitFor()
}

function trackExcalidraw(page: Page, hits: string[]) {
  const pending: Array<Promise<void>> = []
  page.on('response', (response) => {
    const url = response.url()
    const type = response.headers()['content-type'] ?? ''
    if (/WhiteboardCanvas|excalidraw/i.test(url)) {
      hits.push(url.split('?')[0] ?? url)
      return
    }
    const script = /javascript|ecmascript/.test(type) || /\.m?js(\?|$)/.test(url)
    if (!script) return
    pending.push(
      response
        .text()
        .then((text) => {
          if (text.includes('@excalidraw/excalidraw') || text.includes('excalidrawAPI')) {
            hits.push(url.split('?')[0] ?? url)
          }
        })
        .catch(() => undefined),
    )
  })
  return async () => {
    await Promise.all(pending)
  }
}

async function recipeCreate(base: string) {
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await signUpUi(page, base, 'Board Lead')
  const team = await page.evaluate(async () => {
    const response = await fetch('/api/atlas/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Board Team' }),
    })
    return { status: response.status, body: (await response.json()) as { spaceId?: string } }
  })
  console.log(`team_status=${team.status}`)
  if (team.status !== 201 || !team.body.spaceId) fail('team create failed')
  await page.goto(`${base}/s/${team.body.spaceId}`, { waitUntil: 'networkidle' })
  await page.locator('.tree').waitFor()
  await openWhiteboard(page)
  const canvas = await page.locator('.excalidraw').count()
  expectLine('whiteboard_created', canvas > 0, true)
  await page.getByRole('button', { name: 'Create page' }).click()
  await page.locator('.top .new-page').getByRole('button', { name: 'Page', exact: true }).click()
  await page.locator('.doc-editor').waitFor()
  const pens = await page.locator('.tree svg.pen').count()
  const rows = await page.locator('.tree a.it').count()
  console.log(`pen_rows=${pens}`)
  console.log(`tree_rows=${rows}`)
  expectLine('sidebar_row_differs', pens === 1 && rows >= 2, true)
  await browserApp.close()
}

async function recipeAccess(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Owner')
  const outsider = await signUp(base, 'Outsider')
  const member = await signUp(base, 'Member')
  const spaceId = await personalSpaceId(owner.id)
  const title = `Hidden ${crypto.randomUUID().slice(0, 8)}`
  const board = await createPage(owner.id, {
    spaceId,
    title,
    kind: 'whiteboard',
  })
  const drawingId = board.drawing?.id
  if (!drawingId) fail('drawing=missing')
  const team = await createTeam(base, owner.cookie, 'Access Team')
  await invite(base, owner.cookie, team.id, member.email, member.cookie)
  const teamBoard = await createPage(owner.id, {
    spaceId: team.spaceId,
    title: `Team ${crypto.randomUUID().slice(0, 8)}`,
    kind: 'whiteboard',
  })
  const outsiderToken = await createToken(base, outsider.cookie, 'outsider')
  const memberToken = await createToken(base, member.cookie, 'member')
  const save = {
    version: 1,
    elements: elements(),
    appState: {},
    files: {},
  }
  const missing = await drawingRequest(base, 'GET', '/api/drawings?pageId=missing-page', {
    cookie: owner.cookie,
  })
  const checks: Array<[string, { status: number; text: string }]> = [
    ['outsider_page_get', await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, { cookie: outsider.cookie })],
    ['outsider_page_post', await drawingRequest(base, 'POST', '/api/drawings', { cookie: outsider.cookie, body: { ...save, pageId: board.id } })],
    ['outsider_drawing_get', await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, { cookie: outsider.cookie })],
    ['outsider_drawing_post', await drawingRequest(base, 'POST', '/api/drawings', { cookie: outsider.cookie, body: { ...save, drawingId } })],
    ['token_page_get', await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, { token: outsiderToken })],
    ['token_page_post', await drawingRequest(base, 'POST', '/api/drawings', { token: outsiderToken, body: { ...save, pageId: board.id } })],
    ['token_drawing_get', await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, { token: outsiderToken })],
    ['token_drawing_post', await drawingRequest(base, 'POST', '/api/drawings', { token: outsiderToken, body: { ...save, drawingId } })],
  ]
  for (const [name, result] of checks) expectLine(name, result.status, 404)
  expectLine('missing_status', missing.status, 404)
  expectLine(
    'outsider_body_matches_missing',
    checks[0][1].text === missing.text && checks[2][1].text === missing.text,
    true,
  )
  expectLine(
    'token_body_matches_missing',
    checks[4][1].text === missing.text && checks[6][1].text === missing.text,
    true,
  )
  const search = await api(base, outsider.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(title)}`)
  expectLine('outsider_search_visible', search.text.includes(board.id), false)

  const removedPage = await drawingRequest(
    base,
    'GET',
    `/api/drawings?pageId=${teamBoard.id}`,
    { cookie: member.cookie },
  )
  expectLine('member_before_removal', removedPage.status, 200)
  const removed = await api(
    base,
    owner.cookie,
    'DELETE',
    `/api/atlas/teams/${team.id}/members/${member.id}`,
  )
  expectLine('remove_status', removed.status, 200)
  const afterGet = await drawingRequest(base, 'GET', `/api/drawings?pageId=${teamBoard.id}`, {
    cookie: member.cookie,
  })
  const afterPost = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: member.cookie,
    body: { ...save, pageId: teamBoard.id },
  })
  const afterTokenGet = await drawingRequest(
    base,
    'GET',
    `/api/drawings?drawingId=${teamBoard.drawing?.id}`,
    { token: memberToken },
  )
  const afterTokenPost = await drawingRequest(base, 'POST', '/api/drawings', {
    token: memberToken,
    body: { ...save, drawingId: teamBoard.drawing?.id },
  })
  expectLine('removed_page_get', afterGet.status, 404)
  expectLine('removed_page_post', afterPost.status, 404)
  expectLine('removed_token_get', afterTokenGet.status, 404)
  expectLine('removed_token_post', afterTokenPost.status, 404)
  expectLine('removed_body_matches_missing', afterGet.text === missing.text, true)
  const removedSearch = await api(
    base,
    member.cookie,
    'GET',
    `/api/atlas/search?q=${encodeURIComponent(teamBoard.title)}`,
  )
  expectLine('removed_search_visible', removedSearch.text.includes(teamBoard.id), false)
}

async function recipeReload(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Reload')
  const spaceId = await personalSpaceId(owner.id)
  const board = await createPage(owner.id, {
    spaceId,
    title: 'Reload board',
    kind: 'whiteboard',
  })
  const posted = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: { pageId: board.id, version: 1, elements: elements(), appState: { gridSize: 20 }, files: {} },
  })
  expectLine('save_status', posted.status, 200)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  const body = JSON.parse(loaded.text) as { elements?: unknown[] }
  expectLine(
    'reload_scene_identical',
    loaded.status === 200 &&
      canonicalElements(body.elements ?? []) === canonicalElements(elements()),
    true,
  )
}

async function recipeFlush(base: string) {
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await signUpUi(page, base, 'Flush Board')
  await openWhiteboard(page)
  await page.route('**/api/drawings', async (route) => {
    const body = route.request().postData() ?? ''
    if (route.request().method() === 'POST' && body.includes('"via":"autosave"')) {
      await route.abort()
      return
    }
    await route.continue()
  })
  const canvas = page.locator('.excalidraw canvas').first()
  await canvas.waitFor()
  const box = await canvas.boundingBox()
  if (!box) fail('canvas_box=missing')
  const startX = box.x + box.width * 0.45
  const startY = box.y + box.height * 0.45
  await page.mouse.click(startX, startY)
  await page.keyboard.press('r')
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 160, startY + 100, { steps: 10 })
  await page.mouse.up()
  const autosave = await page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes('/api/drawings') &&
      (request.postData() ?? '').includes('"via":"autosave"'),
    { timeout: 10_000 },
  )
  console.log('autosave_aborted=true')
  await page.locator('.retry').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(2000)
  console.log('waited_ms=2000')
  const flush = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/drawings') &&
      (response.request().postData() ?? '').includes('"via":"flush"'),
    { timeout: 10_000 },
  )
  await page.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get() {
        return 'hidden'
      },
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })()`)
  const response = await flush
  const sent = JSON.parse(autosave.postData() ?? '{}') as {
    pageId?: string
    elements?: unknown[]
  }
  const flushed = JSON.parse(response.request().postData() ?? '{}') as {
    pageId?: string
    elements?: unknown[]
  }
  expectLine('flush_status', response.status(), 200)
  const pageId = flushed.pageId || new URL(page.url()).pathname.split('/').pop() || ''
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.excalidraw').waitFor({ timeout: 30_000 })
  const cookies = await page.context().cookies()
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ')
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?pageId=${pageId}`, {
    cookie,
  })
  const stored = (JSON.parse(loaded.text) as { elements?: unknown[] }).elements ?? []
  expectLine(
    'flush_hidden_scene_identical',
    loaded.status === 200 &&
      canonicalElements(stored) === canonicalElements(flushed.elements ?? []) &&
      canonicalElements(stored) === canonicalElements(sent.elements ?? []) &&
      stored.length > 0,
    true,
  )
  await browserApp.close()
}

async function recipeStale(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Stale')
  const spaceId = await personalSpaceId(owner.id)
  const board = await createPage(owner.id, {
    spaceId,
    title: 'Stale board',
    kind: 'whiteboard',
  })
  const first = elements()
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: { pageId: board.id, version: 1, elements: first, appState: {}, files: {} },
  })
  expectLine('first_status', saved.status, 200)
  const second = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: {
      pageId: board.id,
      version: 1,
      elements: [{ id: 'replaced', type: 'text', text: 'replaced' }],
      appState: {},
      files: {},
    },
  })
  expectLine('stale_status', second.status, 409)
  expectLine('stale_body', second.text.includes('board changed, reload'), true)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  const body = JSON.parse(loaded.text) as { elements?: unknown[]; version?: number }
  expectLine(
    'stored_unchanged',
    body.version === 2 && canonicalElements(body.elements ?? []) === canonicalElements(first),
    true,
  )

  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(`${base}/sign-in`, { waitUntil: 'networkidle' })
  await page.context().addCookies(
    owner.cookie.split('; ').map((part: string) => {
      const [name, ...rest] = part.split('=')
      return {
        name: name ?? '',
        value: rest.join('='),
        url: base,
      }
    }),
  )
  await page.route('**/api/drawings', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'board changed, reload' }),
      })
      return
    }
    await route.continue()
  })
  await page.goto(`${base}/s/${spaceId}/p/${board.id}`, { waitUntil: 'networkidle' })
  await page.locator('#page-title').waitFor()
  await page.locator('#page-title').fill('Conflict title')
  await page.getByRole('button', { name: 'Reload' }).waitFor({ timeout: 10_000 })
  const banner = await page.locator('.retry').innerText()
  expectLine(
    'reload_prompt',
    banner.includes('board changed, reload') && banner.includes('Reload'),
    true,
  )
  await browserApp.close()
}

async function recipeOversize(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Oversize')
  const spaceId = await personalSpaceId(owner.id)
  const board = await createPage(owner.id, {
    spaceId,
    title: 'Big board',
    kind: 'whiteboard',
  })
  const pad = 'x'.repeat(2 * 1024 * 1024 + 1)
  const oversize = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: pad,
  })
  expectLine('oversize_status', oversize.status, 413)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  const body = JSON.parse(loaded.text) as { version?: number; elements?: unknown[] }
  expectLine(
    'stored_oversize',
    !(loaded.status === 200 && body.version === 1 && (body.elements ?? []).length === 0),
    false,
  )
}

async function recipeReject(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Reject')
  const spaceId = await personalSpaceId(owner.id)
  const board = await createPage(owner.id, {
    spaceId,
    title: 'Reject board',
    kind: 'whiteboard',
  })
  const files = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: {
      pageId: board.id,
      version: 1,
      elements: [],
      appState: {},
      files: { a: { id: 'a' } },
    },
  })
  const image = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: {
      pageId: board.id,
      version: 1,
      elements: [{ id: 'img', type: 'image' }],
      appState: {},
      files: {},
    },
  })
  expectLine('files_status', files.status, 400)
  expectLine('image_status', image.status, 400)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  const body = JSON.parse(loaded.text) as { version?: number }
  expectLine('stored_rejected', loaded.status === 200 && body.version !== 1, false)
}

async function recipeSearch(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Search')
  const spaceId = await personalSpaceId(owner.id)
  const title = `Label ${crypto.randomUUID().slice(0, 8)}`
  const board = await createPage(owner.id, {
    spaceId,
    title,
    kind: 'whiteboard',
  })
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: { pageId: board.id, version: 1, elements: elements(), appState: {}, files: {} },
  })
  expectLine('save_status', saved.status, 200)
  const titleHits = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(title)}`)
  const labelHits = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(LABEL)}`)
  const secretHits = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(SECRET)}`)
  expectLine('title_visible', titleHits.status === 200 && titleHits.text.includes(board.id), true)
  expectLine('label_visible', labelHits.status === 200 && labelHits.text.includes(board.id), true)
  expectLine('scene_secret_visible', secretHits.text.includes(board.id), false)
}

async function recipeChunk(base: string) {
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  const hits: string[] = []
  const settle = trackExcalidraw(page, hits)
  await signUpUi(page, base, 'Chunk')
  await page.locator('.tree .new-page button').click()
  await page.locator('.tree .new-page').getByRole('button', { name: 'Page', exact: true }).click()
  await page.locator('.doc-editor').waitFor()
  await page.waitForLoadState('networkidle')
  await settle()
  const docHits = hits.length
  if (docHits !== 0) console.log(`doc_excalidraw_url=${hits[0]}`)
  expectLine('doc_excalidraw_requests', docHits, 0)
  await openWhiteboard(page)
  await page.waitForLoadState('networkidle')
  await settle()
  expectLine('board_excalidraw_requests', hits.length - docHits > 0, true)
  const ui = (await page.evaluate(`(() => {
    const shown = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const text = document.body.innerText.toLowerCase()
    return {
      library: shown('.default-sidebar-trigger') || shown('button[title="Library"]'),
      collab: shown('[data-testid="collab-button"]'),
      image: shown('.excalidraw [aria-label="Image"]') || shown('.excalidraw [title="Image"]'),
      watermark: text.includes('watermark') || text.includes('unlicensed'),
    }
  })()`)) as {
    library: boolean
    collab: boolean
    image: boolean
    watermark: boolean
  }
  expectLine('watermark', ui.watermark ? 'present' : 'absent', 'absent')
  expectLine('library_visible', ui.library, false)
  expectLine('collab_visible', ui.collab, false)
  expectLine('image_tool_visible', ui.image, false)
  await browserApp.close()
}

async function recipeMcp(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Agent')
  const spaceId = await personalSpaceId(owner.id)
  const board = await createPage(owner.id, {
    spaceId,
    title: 'Agent board',
    kind: 'whiteboard',
  })
  const token = await createToken(base, owner.cookie, 'agent')
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: { pageId: board.id, version: 1, elements: elements(), appState: { gridSize: 12 }, files: {} },
  })
  expectLine('save_status', saved.status, 200)
  const before = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  const read = await mcp(base, token, 'read_page', { page_id: board.id })
  expectLine('read_status', read.status, 200)
  expectLine('read_body', read.data.body ?? '', 'Whiteboard, open in Atlas to view')
  const updated = await mcp(base, token, 'update_page', {
    page_id: board.id,
    title: 'Agent title',
    body: 'do not store this scene',
    updated_at: read.data.updated_at,
  })
  expectLine('update_status', updated.status, 200)
  expectLine('title_updated', updated.data.title === 'Agent title', true)
  const afterTitle = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  expectLine('scene_unchanged', afterTitle.text === before.text, true)
  const bodyOnly = await mcp(base, token, 'update_page', {
    page_id: board.id,
    body: 'body only',
    updated_at: updated.data.updated_at,
  })
  expectLine('body_only_status', bodyOnly.status, 200)
  expectLine('body_only_title', bodyOnly.data.title === 'Agent title', true)
  const afterBody = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  expectLine('body_only_scene_unchanged', afterBody.text === before.text, true)
}

async function recipeArchive(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Archive')
  const spaceId = await personalSpaceId(owner.id)
  const title = `Archived ${crypto.randomUUID().slice(0, 8)}`
  const board = await createPage(owner.id, {
    spaceId,
    title,
    kind: 'whiteboard',
  })
  const child = await createPage(owner.id, {
    spaceId,
    parentId: board.id,
    title: `Child ${crypto.randomUUID().slice(0, 8)}`,
  })
  const token = await createToken(base, owner.cookie, 'archive')
  await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: { pageId: board.id, version: 1, elements: elements(), appState: {}, files: {} },
  })
  await archivePage(owner.id, board.id)
  const listed = await listPageTree(owner.id, spaceId)
  const tree = treeIds(listed.tree)
  expectLine('archived_tree', tree.includes(board.id), false)
  expectLine('child_hidden', !tree.includes(child.id), true)
  const search = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(LABEL)}`)
  const titleSearch = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(title)}`)
  expectLine(
    'archived_search',
    search.text.includes(board.id) || titleSearch.text.includes(board.id),
    false,
  )
  const read = await mcp(base, token, 'get_page', { page_id: board.id })
  expectLine('archived_mcp_status', read.status, 404)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?pageId=${board.id}`, {
    cookie: owner.cookie,
  })
  expectLine('archived_drawing_status', loaded.status, 404)
}

async function recipeScroll(base: string) {
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await signUpUi(page, base, 'Scroll')
  await openWhiteboard(page)
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expectLine('scrollbar_1280', wide, false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.excalidraw').waitFor()
  const narrow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expectLine('scrollbar_390', narrow, false)
  await browserApp.close()
}

async function recipeRetry(base: string) {
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await signUpUi(page, base, 'Retry')
  await openWhiteboard(page)
  await page.route('**/api/drawings', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'failed' }),
      })
      return
    }
    await route.continue()
  })
  await page.locator('#page-title').fill('Unsaved title')
  await page.locator('.retry').waitFor({ timeout: 10_000 })
  const banner = await page.locator('.retry').innerText()
  expectLine(
    'retry_banner',
    banner.includes("Couldn't save.") && banner.includes('Retry'),
    true,
  )
  await browserApp.close()
}

const recipes: Record<string, (base: string) => Promise<void>> = {
  create: recipeCreate,
  access: recipeAccess,
  reload: recipeReload,
  flush: recipeFlush,
  stale: recipeStale,
  oversize: recipeOversize,
  reject: recipeReject,
  search: recipeSearch,
  chunk: recipeChunk,
  mcp: recipeMcp,
  archive: recipeArchive,
  scroll: recipeScroll,
  retry: recipeRetry,
}

const name = process.argv[2] ?? ''
const recipe = recipes[name]
if (!recipe) {
  fail(
    'usage: whiteboard-fail.ts create|access|reload|flush|stale|oversize|reject|search|chunk|mcp|archive|scroll|retry',
  )
}

const base = baseUrl()
recipe(base)
  .then(async () => {
    await closeDb().catch(() => undefined)
    if (failed) process.exit(1)
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'whiteboard recipe failed'
    console.error(redact(message))
    await closeDb().catch(() => undefined)
    process.exit(1)
  })
