import { chromium, type Page } from 'playwright'
import { closeDb, getSql } from '../src/lib/db'
import { diagramIds } from '../src/lib/diagram'
import { canonicalElements } from '../src/lib/drawing'
import {
  archivePage,
  createDiagram,
  createPage,
  duplicatePage,
  getPageView,
  savePage,
} from '../src/lib/pages'
import { assertLocalBaseUrl, assertLocalDatabaseUrl, submitAuthForm } from './verify-local.ts'

const PASSWORD = 'diagram-recipe-pass'
const LABEL = 'diagramlabel'
const SECRET = 'scene-secret-needle'

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
  let payload: {
    result?: { content?: Array<{ text?: string }> }
    error?: { message?: string }
  }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    payload = {}
  }
  let data: {
    id?: string
    body?: string
    title?: string
    updated_at?: string
    hits?: Array<{ id?: string }>
  } = {}
  try {
    data = JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as typeof data
  } catch {
    data = {}
  }
  return { status: response.status, data }
}

function elements(label = LABEL, secret = SECRET) {
  return [
    { id: secret, type: 'rectangle', text: secret, x: 4, y: 6, width: 20, height: 10 },
    { id: 'label-1', type: 'text', text: label, x: 8, y: 9 },
  ]
}

function sceneBody(drawingId: string, version: number, extra?: Record<string, unknown>) {
  return {
    drawingId,
    version,
    elements: elements(),
    appState: { [SECRET]: true },
    files: {},
    ...extra,
  }
}

function storedElements(text: string) {
  const body = JSON.parse(text) as { elements?: unknown[] }
  return canonicalElements(body.elements ?? [])
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

async function openDoc(page: Page) {
  const toggle = page.locator('.tree .new-page button').first()
  const pageButton = page.locator('.tree .new-page').getByRole('button', { name: 'Page', exact: true })
  await toggle.waitFor()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await toggle.click()
    if (await pageButton.isVisible().catch(() => false)) break
    await page.waitForTimeout(300)
  }
  await pageButton.click()
  await page.locator('.doc-editor').waitFor()
}

function trackExcalidraw(page: Page, hits: string[]) {
  const pending: Array<Promise<void>> = []
  page.on('response', (response) => {
    const url = response.url()
    const type = response.headers()['content-type'] ?? ''
    if (/WhiteboardCanvas|excalidraw|DiagramEditor/i.test(url)) {
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

async function addSession(page: Page, base: string, cookie: string) {
  await page.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.context().addCookies(
    cookie.split('; ').map((part) => {
      const [name, ...rest] = part.split('=')
      return { name: name ?? '', value: rest.join('='), url: base }
    }),
  )
}

async function pasteHtml(page: Page, html: string) {
  await page.locator('.ProseMirror').evaluate((el, payload) => {
    const data = new DataTransfer()
    data.setData('text/html', payload)
    data.setData('text/plain', 'drawing')
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    el.dispatchEvent(event)
  }, html)
}

async function drawStroke(page: Page) {
  const canvas = page.locator('.diagram-screen .excalidraw canvas').first()
  await canvas.waitFor({ timeout: 30_000 })
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
}

async function recipeAccess(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Owner')
  const outsider = await signUp(base, 'Outsider')
  const spaceId = await personalSpaceId(owner.id)
  const doc = await createPage(owner.id, { spaceId, title: 'Hidden diagram' })
  const created = await createDiagram(owner.id, doc.id)
  const outsiderToken = await createToken(base, outsider.cookie, 'outsider')
  const save = { version: 1, elements: elements(), appState: {}, files: {} }
  const missing = await drawingRequest(base, 'GET', '/api/drawings?pageId=missing-page', {
    cookie: owner.cookie,
  })
  const missingDrawing = await drawingRequest(
    base,
    'GET',
    '/api/drawings?drawingId=missing-drawing',
    { cookie: owner.cookie },
  )
  const checks: Array<[string, { status: number; text: string }]> = [
    ['outsider_page_get', await drawingRequest(base, 'GET', `/api/drawings?pageId=${doc.id}`, { cookie: outsider.cookie })],
    ['outsider_page_post', await drawingRequest(base, 'POST', '/api/drawings', { cookie: outsider.cookie, body: { ...save, pageId: doc.id } })],
    ['outsider_drawing_get', await drawingRequest(base, 'GET', `/api/drawings?drawingId=${created.id}`, { cookie: outsider.cookie })],
    ['outsider_drawing_post', await drawingRequest(base, 'POST', '/api/drawings', { cookie: outsider.cookie, body: { ...save, drawingId: created.id } })],
    ['token_page_get', await drawingRequest(base, 'GET', `/api/drawings?pageId=${doc.id}`, { token: outsiderToken })],
    ['token_page_post', await drawingRequest(base, 'POST', '/api/drawings', { token: outsiderToken, body: { ...save, pageId: doc.id } })],
    ['token_drawing_get', await drawingRequest(base, 'GET', `/api/drawings?drawingId=${created.id}`, { token: outsiderToken })],
    ['token_drawing_post', await drawingRequest(base, 'POST', '/api/drawings', { token: outsiderToken, body: { ...save, drawingId: created.id } })],
  ]
  for (const [name, result] of checks) expectLine(name, result.status, 404)
  expectLine('missing_status', missing.status, 404)
  expectLine('missing_drawing_status', missingDrawing.status, 404)
  expectLine('missing_bodies_match', missing.text === missingDrawing.text, true)
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
}

async function seedDiagram(base: string, title: string) {
  databaseUrl()
  const owner = await signUp(base, 'Owner')
  const spaceId = await personalSpaceId(owner.id)
  const doc = await createPage(owner.id, { spaceId, title })
  const created = await createDiagram(owner.id, doc.id)
  await savePage(owner.id, {
    pageId: doc.id,
    title,
    body: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Keep this' }] },
        { type: 'diagram', attrs: { drawingId: created.id } },
      ],
    },
  })
  return { owner, spaceId, doc, drawingId: created.id }
}

async function recipeRoundTrip(base: string) {
  const { owner, doc, drawingId } = await seedDiagram(base, 'Agent diagram')
  const token = await createToken(base, owner.cookie, 'agent')
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(drawingId, 1, {
      previewSvg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${LABEL}</text></svg>`,
    }),
  })
  expectLine('save_status', saved.status, 200)
  const before = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  const read = await mcp(base, token, 'get_page', { page_id: doc.id })
  const placeholder = `[Drawing](atlas://drawing/${drawingId})`
  expectLine('placeholder_link', (read.data.body ?? '').includes(placeholder), true)
  const updated = await mcp(base, token, 'update_page', {
    page_id: doc.id,
    body: read.data.body,
    updated_at: read.data.updated_at,
  })
  expectLine('update_status', updated.status, 200)
  const after = await getPageView(owner.id, doc.id)
  expectLine('drawing_id_kept', diagramIds(after.body)[0] === drawingId, true)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  expectLine('scene_unchanged', loaded.text === before.text, true)
  expectLine('placeholder_roundtrip', (updated.data.body ?? '').includes(placeholder), true)
}

async function recipeRemove(base: string) {
  const { owner, doc, drawingId } = await seedDiagram(base, 'Remove diagram')
  const token = await createToken(base, owner.cookie, 'agent')
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(drawingId, 1),
  })
  expectLine('save_status', saved.status, 200)
  const before = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  const read = await mcp(base, token, 'get_page', { page_id: doc.id })
  const removed = await mcp(base, token, 'update_page', {
    page_id: doc.id,
    body: 'Just text',
    updated_at: read.data.updated_at,
  })
  expectLine('update_status', removed.status, 200)
  const after = await getPageView(owner.id, doc.id)
  expectLine(
    'block_removed',
    diagramIds(after.body).length === 0 && !(removed.data.body ?? '').includes(drawingId),
    true,
  )
  const rows = await getSql()<{ id: string }[]>`
    select id from drawing where id = ${drawingId}
  `
  expectLine('drawing_row_kept', rows.length === 1, true)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  expectLine('scene_unchanged', loaded.text === before.text, true)
}

async function recipeChunk(base: string) {
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  const hits: string[] = []
  const settle = trackExcalidraw(page, hits)
  await signUpUi(page, base, 'Chunk')
  await openDoc(page)
  await page.waitForLoadState('networkidle')
  await settle()
  if (hits.length !== 0) console.log(`doc_excalidraw_url=${hits[0]}`)
  expectLine('doc_excalidraw_requests', hits.length, 0)
  await browserApp.close()
}

async function recipeSearch(base: string) {
  const { owner, doc, drawingId } = await seedDiagram(base, `Label ${crypto.randomUUID().slice(0, 8)}`)
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(drawingId, 1, {
      previewSvg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${SECRET}</text></svg>`,
    }),
  })
  expectLine('save_status', saved.status, 200)
  const labelHits = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(LABEL)}`)
  const secretHits = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(SECRET)}`)
  expectLine('label_visible', labelHits.status === 200 && labelHits.text.includes(doc.id), true)
  expectLine('scene_secret_visible', secretHits.text.includes(doc.id), false)
  const rows = await getSql()<{ body_text: string | null }[]>`
    select body_text from page where id = ${doc.id}
  `
  const text = rows[0]?.body_text ?? ''
  expectLine('body_text_has_label', text.includes(LABEL), true)
  expectLine('body_text_has_secret', text.includes(SECRET), false)
}

async function recipeEdit(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'DiagramEdit')
  const spaceId = await personalSpaceId(owner.id)
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await addSession(page, base, owner.cookie)
  await page.goto(`${base}/s/${spaceId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.tree').waitFor()
  await openDoc(page)
  await page.getByRole('button', { name: 'Drawing' }).click()
  await page.getByText('Empty drawing').waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.diagram-screen .excalidraw').waitFor({ timeout: 30_000 })
  await drawStroke(page)
  await page.locator('.diagram-bar').getByText('Saving', { exact: true }).waitFor({ timeout: 10_000 })
  await page.locator('.diagram-bar').getByText('Saved', { exact: true }).waitFor({ timeout: 15_000 })
  const done = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/drawings') &&
      (response.request().postData() ?? '').includes('"via":"autosave"'),
    { timeout: 15_000 },
  )
  await page.locator('.diagram-bar').getByRole('button', { name: 'Done' }).click()
  const doneResponse = await done
  await page.locator('.diagram-screen').waitFor({ state: 'hidden', timeout: 15_000 })
  const first = JSON.parse(doneResponse.request().postData() ?? '{}') as { elements?: unknown[] }
  const drawingId = await page.locator('.diagram-block').getAttribute('data-drawing-id')
  if (!drawingId) fail('drawing_id=missing')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.diagram-block').waitFor()
  const cookies = await page.context().cookies()
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ')
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, { cookie })
  expectLine(
    'reload_scene_identical',
    loaded.status === 200 && storedElements(loaded.text) === canonicalElements(first.elements ?? []) && (first.elements ?? []).length > 0,
    true,
  )

  await page.route('**/api/drawings', async (route) => {
    const body = route.request().postData() ?? ''
    if (route.request().method() === 'POST' && body.includes('"via":"autosave"')) {
      await route.abort()
      return
    }
    await route.continue()
  })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.diagram-screen .excalidraw').waitFor({ timeout: 30_000 })
  await drawStroke(page)
  const autosave = await page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes('/api/drawings') &&
      (request.postData() ?? '').includes('"via":"autosave"'),
    { timeout: 10_000 },
  )
  console.log('autosave_aborted=true')
  await page.locator('.diagram-screen .retry').waitFor({ timeout: 10_000 })
  const banner = await page.locator('.diagram-screen .retry').innerText()
  expectLine('retry_banner', banner.includes("Couldn't save.") && banner.includes('Retry'), true)
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
  const sent = JSON.parse(autosave.postData() ?? '{}') as { elements?: unknown[] }
  const flushed = JSON.parse(response.request().postData() ?? '{}') as { elements?: unknown[] }
  expectLine('flush_status', response.status(), 200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.diagram-block').waitFor()
  const again = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, { cookie })
  const stored = storedElements(again.text)
  expectLine(
    'flush_hidden_scene_identical',
    again.status === 200 &&
      stored === canonicalElements(flushed.elements ?? []) &&
      stored === canonicalElements(sent.elements ?? []) &&
      (flushed.elements ?? []).length > 0,
    true,
  )
  await browserApp.close()
}

async function recipeArchive(base: string) {
  const title = `Archived ${crypto.randomUUID().slice(0, 8)}`
  const { owner, doc, drawingId } = await seedDiagram(base, title)
  const token = await createToken(base, owner.cookie, 'archive')
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(drawingId, 1),
  })
  expectLine('save_status', saved.status, 200)
  await archivePage(owner.id, doc.id)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  const byPage = await drawingRequest(base, 'GET', `/api/drawings?pageId=${doc.id}`, {
    cookie: owner.cookie,
  })
  expectLine('archived_api', loaded.status === 404 && byPage.status === 404, true)
  const search = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(LABEL)}`)
  const titleSearch = await api(base, owner.cookie, 'GET', `/api/atlas/search?q=${encodeURIComponent(title)}`)
  expectLine(
    'archived_search',
    search.text.includes(doc.id) || titleSearch.text.includes(doc.id),
    false,
  )
  const read = await mcp(base, token, 'get_page', { page_id: doc.id })
  expectLine('archived_mcp_status', read.status, 404)
}

async function recipeCopy(base: string) {
  const seeded = await seedDiagram(base, 'Copy diagram')
  const { owner, doc, drawingId, spaceId } = seeded
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(drawingId, 1),
  })
  expectLine('save_status', saved.status, 200)
  const before = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  const copied = await duplicatePage(owner.id, doc.id)
  const copiedIds = diagramIds(copied.body)
  const copiedId = copiedIds[0] ?? ''
  expectLine('duplicate_ids_differ', copiedId !== '' && copiedId !== drawingId, true)
  const copiedScene = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${copiedId}`, {
    cookie: owner.cookie,
  })
  expectLine(
    'duplicate_scene_copied',
    copiedScene.status === 200 && storedElements(copiedScene.text) === storedElements(before.text),
    true,
  )
  const mutated = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: {
      drawingId: copiedId,
      version: 1,
      elements: [{ id: 'copy-only', type: 'text', text: 'copy only' }],
      appState: {},
      files: {},
    },
  })
  expectLine('duplicate_mutate_status', mutated.status, 200)
  const original = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  expectLine('original_unchanged', original.text === before.text, true)

  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await addSession(page, base, owner.cookie)
  await page.goto(`${base}/s/${spaceId}/p/${doc.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('Keep this').click()
  await pasteHtml(
    page,
    `<figure data-drawing-id="${drawingId}" class="diagram-block"></figure>`,
  )
  let pasteId = ''
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    const view = await getPageView(owner.id, doc.id)
    const ids = diagramIds(view.body)
    pasteId = ids.find((id) => id !== drawingId) ?? ''
    if (pasteId && ids.includes(drawingId)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  expectLine('paste_ids_differ', pasteId !== '' && pasteId !== drawingId, true)
  const pasted = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${pasteId}`, {
    cookie: owner.cookie,
  })
  expectLine(
    'paste_scene_copied',
    pasted.status === 200 && storedElements(pasted.text) === storedElements(before.text),
    true,
  )
  await browserApp.close()
}

async function recipeLazy(base: string) {
  const { owner, doc, spaceId } = await seedDiagram(base, 'Lazy diagram')
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  const hits: string[] = []
  const settle = trackExcalidraw(page, hits)
  await addSession(page, base, owner.cookie)
  await page.goto(`${base}/s/${spaceId}/p/${doc.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('Empty drawing').waitFor()
  await settle()
  const before = hits.length
  if (before !== 0) console.log(`before_edit_url=${hits[0]}`)
  expectLine('before_edit_excalidraw_requests', before, 0)
  await page.evaluate(() => {
    const flag = window as unknown as { __sawSpin?: boolean }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.classList.contains('diagram-spin') || node.querySelector('.diagram-spin')) {
            flag.__sawSpin = true
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.waitForFunction(
    () => (window as unknown as { __sawSpin?: boolean }).__sawSpin === true,
    undefined,
    { timeout: 10_000 },
  )
  expectLine('saw_spinner', true, true)
  await page.locator('.diagram-screen .excalidraw').waitFor({ timeout: 30_000 })
  await settle()
  expectLine('after_edit_excalidraw_requests', hits.length - before > 0, true)
  const ui = (await page.evaluate(`(() => {
    const shown = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    return {
      library: shown('.default-sidebar-trigger') || shown('button[title="Library"]'),
      collab: shown('[data-testid="collab-button"]'),
      image: shown('.excalidraw [aria-label="Image"]') || shown('.excalidraw [title="Image"]'),
    }
  })()`)) as { library: boolean; collab: boolean; image: boolean }
  expectLine('library_visible', ui.library, false)
  expectLine('collab_visible', ui.collab, false)
  expectLine('image_tool_visible', ui.image, false)
  await browserApp.close()
}

const DIRTY = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10" /></svg>`

async function recipeClean(base: string) {
  const { owner, drawingId } = await seedDiagram(base, 'Clean svg')
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(drawingId, 1, { previewSvg: DIRTY }),
  })
  expectLine('save_status', saved.status, 200)
  const rows = await getSql()<{ preview_svg: string | null }[]>`
    select preview_svg from drawing where id = ${drawingId}
  `
  const stored = rows[0]?.preview_svg ?? ''
  expectLine('stored_script', /<script/i.test(stored), false)
  expectLine('stored_handler', /onload/i.test(stored), false)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${drawingId}`, {
    cookie: owner.cookie,
  })
  const served = (JSON.parse(loaded.text) as { previewSvg?: string | null }).previewSvg ?? ''
  expectLine('served_script', /<script/i.test(served), false)
  expectLine('served_handler', /onload/i.test(served), false)
}

async function recipeForeign(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Foreign')
  const spaceId = await personalSpaceId(owner.id)
  const source = await createPage(owner.id, { spaceId, title: 'Source' })
  const dest = await createPage(owner.id, { spaceId, title: 'Dest' })
  const created = await createDiagram(owner.id, source.id)
  await savePage(owner.id, {
    pageId: source.id,
    title: 'Source',
    body: {
      type: 'doc',
      content: [{ type: 'diagram', attrs: { drawingId: created.id } }],
    },
  })
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(created.id, 1, {
      previewSvg: '<svg xmlns="http://www.w3.org/2000/svg"><text>FOREIGN</text></svg>',
    }),
  })
  expectLine('save_status', saved.status, 200)
  const before = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${created.id}`, {
    cookie: owner.cookie,
  })
  const sql = getSql()
  const planted = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Dest note' }] },
      { type: 'diagram', attrs: { drawingId: created.id } },
    ],
  }
  await sql`update page set body = ${JSON.stringify(planted)}::jsonb where id = ${dest.id}`
  const browserApp = await browser()
  const page = await browserApp.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript((foreign) => {
    const mark = () => {
      const block = document.querySelector(`[data-drawing-id="${foreign}"] img`)
      if (block) (window as unknown as { __foreignShown?: boolean }).__foreignShown = true
    }
    new MutationObserver(mark).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    })
  }, created.id)
  await addSession(page, base, owner.cookie)
  await page.goto(`${base}/s/${spaceId}/p/${dest.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    (foreign) => {
      const ids = [...document.querySelectorAll('.diagram-block')].map((node) =>
        node.getAttribute('data-drawing-id'),
      )
      return ids.length > 0 && ids.every((id) => id && id !== foreign)
    },
    created.id,
    { timeout: 15_000 },
  )
  const shown = await page.evaluate(
    () => (window as unknown as { __foreignShown?: boolean }).__foreignShown === true,
  )
  expectLine('foreign_id_rendered', shown, false)
  let nextId = ''
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    const view = await getPageView(owner.id, dest.id)
    const ids = diagramIds(view.body)
    nextId = ids[0] ?? ''
    if (nextId && nextId !== created.id) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  expectLine('foreign_id_left_in_body', nextId === created.id || nextId === '', false)
  const copied = nextId
    ? await drawingRequest(base, 'GET', `/api/drawings?drawingId=${nextId}`, {
        cookie: owner.cookie,
      })
    : { status: 0, text: '' }
  let copiedPage = false
  let copiedScene = false
  if (copied.status === 200) {
    try {
      const copiedBody = JSON.parse(copied.text) as { pageId?: string }
      copiedPage = copiedBody.pageId === dest.id
      copiedScene = storedElements(copied.text) === storedElements(before.text)
    } catch {
      copiedPage = false
      copiedScene = false
    }
  }
  expectLine('copied_page_id_matches', copiedPage, true)
  expectLine('copied_scene_matches', copiedScene, true)
  await browserApp.close()
}

async function recipeServe(base: string) {
  const owner = await seedDiagram(base, 'Serve svg')
  const outsider = await signUp(base, 'Outsider')
  const preview = '<svg xmlns="http://www.w3.org/2000/svg"><text>inline</text></svg>'
  const saved = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.owner.cookie,
    body: sceneBody(owner.drawingId, 1, { previewSvg: preview }),
  })
  expectLine('save_status', saved.status, 200)
  const loaded = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${owner.drawingId}`, {
    cookie: owner.owner.cookie,
  })
  const body = JSON.parse(loaded.text) as Record<string, unknown>
  const rows = await getSql()<{ preview_svg: string | null }[]>`
    select preview_svg from drawing where id = ${owner.drawingId}
  `
  const stored = rows[0]?.preview_svg ?? ''
  expectLine('svg_in_drawing_row', stored.includes('<svg') && stored.includes('inline'), true)
  expectLine('served_svg', body.previewSvg === stored, true)
  const fileKeys = ['url', 'fileUrl', 'blob', 'path'].filter((key) => key in body)
  expectLine('file_storage', fileKeys.length > 0 || !Array.isArray(body.elements), false)
  const denied = await drawingRequest(base, 'GET', `/api/drawings?drawingId=${owner.drawingId}`, {
    cookie: outsider.cookie,
  })
  expectLine('outsider_status', denied.status, 404)
}

const stamp = crypto.randomUUID()
const OUTSIDER_SCENE = `outsider-scene-${stamp}`
const OUTSIDER_PREVIEW = `outsider-preview-${stamp}`

function responseLeaks(text: string, sourceId: string) {
  return text.includes(OUTSIDER_SCENE) || text.includes(OUTSIDER_PREVIEW) || text.includes(sourceId)
}

async function copiedForeignRows(sourceId: string) {
  const rows = await getSql()<{ id: string; scene: string; preview: string | null }[]>`
    select id, scene::text as scene, preview_svg as preview from drawing
  `
  return rows.filter(
    (row) =>
      row.id !== sourceId &&
      (row.scene.includes(OUTSIDER_SCENE) || (row.preview ?? '').includes(OUTSIDER_PREVIEW)),
  ).length
}

async function recipeOutsider(base: string) {
  databaseUrl()
  const owner = await signUp(base, 'Source')
  const outsider = await signUp(base, 'Outsider')
  const ownerSpace = await personalSpaceId(owner.id)
  const outsiderSpace = await personalSpaceId(outsider.id)
  const source = await createPage(owner.id, { spaceId: ownerSpace, title: 'Private' })
  const created = await createDiagram(owner.id, source.id)
  await savePage(owner.id, {
    pageId: source.id,
    title: 'Private',
    body: {
      type: 'doc',
      content: [{ type: 'diagram', attrs: { drawingId: created.id } }],
    },
  })
  const planted = await drawingRequest(base, 'POST', '/api/drawings', {
    cookie: owner.cookie,
    body: sceneBody(created.id, 1, {
      elements: elements(LABEL, OUTSIDER_SCENE),
      previewSvg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${OUTSIDER_PREVIEW}</text></svg>`,
    }),
  })
  expectLine('source_save_status', planted.status, 200)
  const dest = await createPage(outsider.id, { spaceId: outsiderSpace, title: 'Mine' })
  const saved = await savePage(outsider.id, {
    pageId: dest.id,
    title: 'Mine',
    body: {
      type: 'doc',
      content: [{ type: 'diagram', attrs: { drawingId: created.id } }],
    },
  })
  const fetched = await drawingRequest(base, 'GET', `/api/drawings?pageId=${dest.id}`, {
    cookie: outsider.cookie,
  })
  expectLine('node_copied', (await copiedForeignRows(created.id)) > 0, false)
  expectLine(
    'node_response_leaks',
    responseLeaks(JSON.stringify(saved), created.id) || responseLeaks(fetched.text, created.id),
    false,
  )
  const token = await createToken(base, outsider.cookie, 'outsider')
  const createdPage = await mcp(base, token, 'create_page', {
    space_id: outsiderSpace,
    title: 'Via agent',
    body: `[Drawing](atlas://drawing/${encodeURIComponent(created.id)})`,
  })
  expectLine('mcp_status', createdPage.status, 200)
  const mcpPageId = createdPage.data.id ?? ''
  const mcpFetched = mcpPageId
    ? await drawingRequest(base, 'GET', `/api/drawings?pageId=${mcpPageId}`, {
        cookie: outsider.cookie,
      })
    : { status: 0, text: '' }
  expectLine('mcp_copied', (await copiedForeignRows(created.id)) > 0, false)
  expectLine(
    'mcp_response_leaks',
    responseLeaks(JSON.stringify(createdPage.data), created.id) ||
      responseLeaks(mcpFetched.text, created.id),
    false,
  )
  const rows = await getSql()<{ id: string }[]>`
    select id from drawing where scene::text like ${'%' + OUTSIDER_SCENE + '%'}
  `
  expectLine('source_only', rows.length === 1 && rows[0]?.id === created.id, true)
}

const recipes: Record<string, (base: string) => Promise<void>> = {
  access: recipeAccess,
  roundtrip: recipeRoundTrip,
  remove: recipeRemove,
  chunk: recipeChunk,
  search: recipeSearch,
  edit: recipeEdit,
  archive: recipeArchive,
  copy: recipeCopy,
  lazy: recipeLazy,
  clean: recipeClean,
  foreign: recipeForeign,
  serve: recipeServe,
  outsider: recipeOutsider,
}

const name = process.argv[2] ?? ''
const recipe = recipes[name]
if (!recipe) {
  fail(
    'usage: diagram-fail.ts access|roundtrip|remove|chunk|search|edit|archive|copy|lazy|clean|foreign|serve|outsider',
  )
}

const base = baseUrl()
recipe(base)
  .then(async () => {
    line('result', failed ? 'fail' : 'pass')
    await closeDb().catch(() => undefined)
    if (failed) process.exit(1)
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'diagram recipe failed'
    console.error(redact(message))
    await closeDb().catch(() => undefined)
    process.exit(1)
  })
