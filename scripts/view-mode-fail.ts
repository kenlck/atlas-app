import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Page, Request } from 'playwright'
import { canonicalElements } from '../src/lib/drawing'
import { assertLocalBaseUrl, clickNewDoc, submitAuthForm } from './verify-local.ts'

const BASE = assertLocalBaseUrl(process.env.BASE_URL ?? 'http://127.0.0.1:3000')
const PASSWORD = 'view-mode-password'
const PIN = '3d03b7041f9636b2947a87133778ce0a22826798'
const SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

let failed = false

function line(name: string, value: string | number | boolean) {
  console.log(`${name}=${value}`)
}

function expectLine(
  name: string,
  value: string | number | boolean,
  want: string | number | boolean,
) {
  line(name, value)
  if (value !== want) failed = true
}

function finish(id: string) {
  console.log(`37_${id}=${failed ? 'fail' : 'pass'}`)
  if (failed) process.exit(1)
}

async function shot(page: Page, name: string) {
  const buf = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  for (const dir of [join('artifacts', SHA), '/opt/cursor/artifacts']) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), buf)
  }
  line('screenshot', name)
}

async function browserPage() {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  return { browser, page }
}

async function signUp(page: Page, name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const email = `${slug}.${crypto.randomUUID()}@example.com`
  await page.goto(`${BASE}/sign-up`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const field = document.querySelector('#name')
    if (!field) return false
    const keys = Object.keys(field)
    for (const key of keys) {
      if (key.startsWith('__reactProps')) return true
    }
    return false
  })
  await page.locator('#name').fill(name)
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.locator('.app').waitFor()
}

async function newDoc(page: Page) {
  const before = page.url()
  await clickNewDoc(page)
  await page.waitForFunction((href) => window.location.href !== href, before)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').waitFor()
}

async function newBoard(page: Page) {
  await page.locator('.tree .new-page button').click()
  await page
    .locator('.tree .new-page')
    .getByRole('button', { name: 'Whiteboard', exact: true })
    .click()
  await page.locator('.excalidraw').waitFor({ timeout: 30_000 })
  await page.locator('#page-title').waitFor()
}

function watchSaves(page: Page) {
  const hits: string[] = []
  const onRequest = (request: Request) => {
    if (request.method() !== 'POST') return
    const url = request.url()
    const body = request.postData() ?? ''
    if (url.includes('/api/pages/save') || url.includes('/api/drawings')) {
      hits.push(new URL(url).pathname)
      return
    }
    if (
      (url.includes('_serverFn') || url.includes('serverFn')) &&
      body.includes('"pageId"') &&
      body.includes('"body"')
    ) {
      hits.push('savePage')
    }
  }
  page.on('request', onRequest)
  return {
    count: () => hits.length,
    reset: () => {
      hits.length = 0
    },
  }
}

async function ruleOn(page: Page) {
  return page.locator('.top.is-editing').evaluate((el) => {
    const probe = document.createElement('div')
    probe.style.borderBottom = '2px solid var(--accent)'
    document.body.appendChild(probe)
    const expected = getComputedStyle(probe)
    const width = expected.borderBottomWidth
    const color = expected.borderBottomColor
    probe.remove()
    const style = getComputedStyle(el)
    return style.borderBottomWidth === width && style.borderBottomColor === color && width === '2px'
  })
}

async function noScroll(page: Page, label: string) {
  const box = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  line(`${label}_scrollWidth`, box.scrollWidth)
  line(`${label}_innerWidth`, box.innerWidth)
  expectLine(`${label}_scroll`, box.scrollWidth > box.innerWidth, false)
}

async function recipeFc1() {
  const { browser, page } = await browserPage()
  const saves = watchSaves(page)
  await signUp(page, 'View Reader')
  await newDoc(page)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.locator('.top.is-editing').waitFor({ state: 'hidden' })
  saves.reset()
  const beforeText = (await page.locator('.doc-editor').innerText()).trim()
  const beforeTitle = await page.locator('#page-title').inputValue()
  const editable = await page.locator('.doc-editor').getAttribute('contenteditable')
  await page.locator('.doc-editor').click()
  await page.locator('.doc-editor').dblclick()
  await page.keyboard.type('should-not-stick')
  await page.locator('#page-title').click()
  await page.keyboard.type('nope')
  await page.waitForTimeout(1200)
  const afterText = (await page.locator('.doc-editor').innerText()).trim()
  const afterTitle = await page.locator('#page-title').inputValue()
  expectLine('fc1_save_requests', saves.count(), 0)
  expectLine('fc1_text_unchanged', afterText === beforeText && !afterText.includes('should-not-stick'), true)
  expectLine('fc1_title_unchanged', afterTitle === beforeTitle, true)
  expectLine('fc1_editable', editable === 'false', true)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  const reloaded = (await page.locator('.doc-editor').innerText()).trim()
  expectLine('fc1_reload_unchanged', reloaded === beforeText, true)
  expectLine('fc1_reload_view', (await page.locator('.top.is-editing').count()) === 0, true)
  await shot(page, 'view_mode.png')
  await browser.close()
  finish('fc1')
}

async function recipeFc2() {
  const { browser, page } = await browserPage()
  await signUp(page, 'View Editor')
  await newDoc(page)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.locator('.top.is-editing').waitFor({ state: 'hidden' })
  const typed = `edited-${crypto.randomUUID().slice(0, 8)}`
  const save = page.waitForResponse((response) => {
    const request = response.request()
    const body = request.postData() ?? ''
    return response.ok() && request.method() === 'POST' && body.includes(typed)
  })
  await page.getByRole('radio', { name: 'Edit', exact: true }).click()
  await page.locator('.top.is-editing').waitFor()
  await page.locator('.doc-editor').click()
  await page.keyboard.type(typed)
  await save
  await page.getByText('Saved', { exact: true }).waitFor()
  const chip = (await page.locator('.editing-chip').innerText()).replace(/\s+/g, ' ')
  expectLine('fc2_rule', await ruleOn(page), true)
  expectLine('fc2_chip', chip.includes('Editing'), true)
  expectLine('fc2_status', chip.includes('Saved'), true)
  expectLine(
    'fc2_text',
    (await page.locator('.doc-editor').innerText()).includes(typed),
    true,
  )
  await shot(page, 'edit_mode_rule_chip.png')
  await browser.close()
  finish('fc2')
}

async function recipeFc3() {
  const { browser, page } = await browserPage()
  await signUp(page, 'View Done')
  await newDoc(page)
  const typed = `flush-${crypto.randomUUID().slice(0, 8)}`
  await page.locator('.doc-editor').click()
  await page.keyboard.type(typed)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.locator('.top.is-editing').waitFor({ state: 'hidden' })
  expectLine(
    'fc3_view',
    (await page.getByRole('radio', { name: 'View', exact: true }).getAttribute('aria-checked')) ===
      'true',
    true,
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  const text = (await page.locator('.doc-editor').innerText()).trim()
  expectLine('fc3_persisted', text === typed, true)
  expectLine('fc3_reload_view', (await page.locator('.top.is-editing').count()) === 0, true)
  await browser.close()
  finish('fc3')
}

async function recipeFc4() {
  const { browser, page } = await browserPage()
  let failSave = true
  await page.route(
    (url) => url.pathname.includes('_serverFn') || url.pathname.includes('serverFn'),
    async (route) => {
      const body = route.request().postData() ?? ''
      if (failSave && body.includes('"pageId"') && body.includes('"body"')) {
        await route.fulfill({
          status: 500,
          contentType: 'text/plain',
          body: 'Internal Server Error',
        })
        return
      }
      await route.continue()
    },
  )
  await signUp(page, 'View Retry')
  await newDoc(page)
  const typed = `retry-${crypto.randomUUID().slice(0, 8)}`
  await page.locator('.doc-editor').click()
  await page.keyboard.type(typed)
  await page.locator('.retry').waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.waitForTimeout(400)
  const banner = (await page.locator('.retry').innerText()).replace(/\s+/g, ' ')
  expectLine('fc4_stayed', (await page.locator('.top.is-editing').count()) === 1, true)
  expectLine('fc4_banner', banner.includes("Couldn't save.") && banner.includes('Retry'), true)
  expectLine('fc4_discard', await page.getByRole('button', { name: 'Discard' }).count(), 0)
  await shot(page, 'failed_save_retry.png')
  failSave = false
  await page.locator('.retry').getByRole('button', { name: 'Retry' }).click()
  await page.getByText('Saved', { exact: true }).waitFor({ timeout: 10_000 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  expectLine(
    'fc4_retry_saved',
    (await page.locator('.doc-editor').innerText()).includes(typed),
    true,
  )
  await browser.close()
  finish('fc4')
}

async function recipeFc5() {
  const { browser, page } = await browserPage()
  await signUp(page, 'View Reload')
  await newDoc(page)
  await page.getByRole('radio', { name: 'Edit', exact: true }).waitFor()
  expectLine(
    'fc5_before',
    (await page.getByRole('radio', { name: 'Edit', exact: true }).getAttribute('aria-checked')) ===
      'true',
    true,
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  const stored = await page.evaluate(() => {
    const keys = [
      ...Object.keys(window.localStorage),
      ...Object.keys(window.sessionStorage),
    ]
    return keys.some((key) => /mode|editing/i.test(key))
  })
  const url = new URL(page.url())
  expectLine('fc5_view', (await page.locator('.top.is-editing').count()) === 0, true)
  expectLine(
    'fc5_editable',
    (await page.locator('.doc-editor').getAttribute('contenteditable')) === 'false',
    true,
  )
  expectLine('fc5_stored', stored, false)
  expectLine('fc5_url', url.search.includes('mode') || url.search.includes('edit'), false)
  await browser.close()
  finish('fc5')
}

async function recipeFc7() {
  const { browser, page } = await browserPage()
  await signUp(page, 'View Fresh')
  await newDoc(page)
  await page.waitForFunction(() => document.activeElement?.id === 'page-title')
  const active = await page.evaluate(() => document.activeElement?.id ?? '')
  const checked = await page
    .getByRole('radio', { name: 'Edit', exact: true })
    .getAttribute('aria-checked')
  expectLine('fc7_edit', checked === 'true', true)
  expectLine('fc7_title_focused', active === 'page-title', true)
  await browser.close()
  finish('fc7')
}

async function recipeFc8() {
  const { browser, page } = await browserPage()
  await signUp(page, 'View Narrow')
  await newDoc(page)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.locator('.top.is-editing').waitFor({ state: 'hidden' })
  expectLine('fc8_switch_1280', await page.locator('.mode-switch').isVisible(), true)
  expectLine('fc8_icon_1280', await page.locator('.mode-icon').isVisible(), false)
  await noScroll(page, 'fc8_1280')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.mode-icon').waitFor()
  expectLine('fc8_switch_390', await page.locator('.mode-switch').isVisible(), false)
  expectLine('fc8_icon_390', await page.locator('.mode-icon').isVisible(), true)
  await noScroll(page, 'fc8_390')
  await shot(page, 'icon_button_390.png')
  await page.locator('.mode-icon').click()
  await page.locator('.top.is-editing').waitFor()
  const edited = await page.locator('.mode-icon').getAttribute('aria-label')
  expectLine('fc8_icon_to_edit', edited === 'View' && (await page.locator('.editing-chip').isVisible()), true)
  await noScroll(page, 'fc8_390_edit')
  await page.locator('.mode-icon').click()
  await page.locator('.top.is-editing').waitFor({ state: 'hidden' })
  expectLine(
    'fc8_icon_to_view',
    (await page.locator('.mode-icon').getAttribute('aria-label')) === 'Edit',
    true,
  )
  await noScroll(page, 'fc8_390_back')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('.mode-switch').waitFor()
  await noScroll(page, 'fc8_1280_back')
  await browser.close()
  finish('fc8')
}

async function recipeFc9() {
  const { browser, page } = await browserPage()
  const saves = watchSaves(page)
  await signUp(page, 'View Board')
  await newBoard(page)
  await page.locator('.excalidraw.excalidraw--view-mode').waitFor()
  saves.reset()
  const pageId = new URL(page.url()).pathname.split('/').pop() ?? ''
  const read = async () =>
    page.evaluate(async (id) => {
      const response = await fetch(`/api/drawings?pageId=${id}`, { credentials: 'include' })
      return { status: response.status, text: await response.text() }
    }, pageId)
  const before = await read()
  const beforeElements = canonicalElements(
    ((JSON.parse(before.text) as { elements?: unknown[] }).elements ?? []),
  )
  const canvas = page.locator('.excalidraw canvas').first()
  const box = await canvas.boundingBox()
  if (!box) {
    expectLine('fc9_canvas', false, true)
  } else {
    const x = box.x + box.width * 0.5
    const y = box.y + box.height * 0.45
    await page.mouse.click(x, y)
    await page.mouse.dblclick(x, y)
    await page.keyboard.type('should-not-draw')
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 140, y + 90, { steps: 8 })
    await page.mouse.up()
    await page.mouse.move(x - 40, y + 30)
    await page.mouse.down()
    await page.mouse.move(x + 80, y - 20, { steps: 6 })
    await page.mouse.up()
  }
  await page.waitForTimeout(1200)
  const after = await read()
  const afterElements = canonicalElements(
    ((JSON.parse(after.text) as { elements?: unknown[] }).elements ?? []),
  )
  expectLine('fc9_view_mode', await page.locator('.excalidraw.excalidraw--view-mode').count(), 1)
  expectLine('fc9_save_requests', saves.count(), 0)
  expectLine('fc9_scene_unchanged', before.status === 200 && afterElements === beforeElements, true)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.excalidraw.excalidraw--view-mode').waitFor()
  const reloaded = await read()
  const reloadedElements = canonicalElements(
    ((JSON.parse(reloaded.text) as { elements?: unknown[] }).elements ?? []),
  )
  expectLine('fc9_reload_scene', reloadedElements === beforeElements, true)
  await browser.close()
  finish('fc9')
}

function pinnedFile(path: string) {
  return execFileSync('git', ['show', `${PIN}:${path}`], { encoding: 'utf8' })
}

function sameFile(path: string) {
  return readFileSync(path, 'utf8') === pinnedFile(path)
}

function statusIn(source: string, pattern: RegExp) {
  const match = pattern.exec(source)
  return match ? Number(match[1]) : -1
}

async function recipeFc10() {
  const savePath = 'src/lib/page-save-request.ts'
  const routePath = 'src/routes/api/pages/save.ts'
  const mcpPath = 'src/lib/mcp.ts'
  const pagesPath = 'src/lib/pages.ts'
  const fnsPath = 'src/server/fns.ts'
  expectLine('fc10_save_source_match', sameFile(savePath), true)
  expectLine('fc10_route_source_match', sameFile(routePath), true)
  expectLine('fc10_mcp_source_match', sameFile(mcpPath), true)
  expectLine('fc10_pages_source_match', sameFile(pagesPath), true)
  expectLine('fc10_fns_source_match', sameFile(fnsPath), true)
  const saveSrc = pinnedFile(savePath)
  const mcpSrc = pinnedFile(mcpPath)
  const pagesSrc = pinnedFile(pagesPath)
  const pinnedSave = statusIn(saveSrc, /return new Response\(null, \{ status: (\d+) \}\)/)
  const pinnedForbidden = statusIn(saveSrc, /error: 'Forbidden' \}, (\d+)/)
  const pinnedConflict = statusIn(pagesSrc, /throw new HttpError\((\d+), 'Conflict'\)/)
  const pinnedUpdate = statusIn(mcpSrc, /function rpc\([\s\S]*?status = (\d+)\)/)
  line('fc10_pinned', PIN)
  line('fc10_pinned_save_status', pinnedSave)
  line('fc10_pinned_forbidden_status', pinnedForbidden)
  line('fc10_pinned_update_status', pinnedUpdate)
  line('fc10_pinned_conflict_status', pinnedConflict)

  const email = `fc10.${crypto.randomUUID()}@example.com`
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ name: 'View Agent', email, password: PASSWORD }),
  })
  const setCookie = signup.headers.getSetCookie()
  const cookie = setCookie
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry.includes('='))
    .join('; ')
  expectLine('fc10_signup', signup.status, 200)
  await signup.text()
  const tokenRes = await fetch(`${BASE}/api/atlas/tokens`, {
    method: 'POST',
    headers: {
      cookie,
      origin: BASE,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'view-mode', scope: 'read_write', expiry: '90d' }),
  })
  const tokenBody = (await tokenRes.json()) as { token?: string }
  expectLine('fc10_token', tokenRes.status, 201)
  const token = tokenBody.token ?? ''
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${BASE}/mcp`, {
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
    return { status: response.status, text }
  }
  const spaces = await call('list_spaces', {})
  const spaceId =
    (
      JSON.parse(
        (
          JSON.parse(spaces.text) as {
            result?: { content?: Array<{ text?: string }> }
          }
        ).result?.content?.[0]?.text ?? '{}',
      ) as { spaces?: Array<{ id?: string }> }
    ).spaces?.[0]?.id ?? ''
  const created = await call('create_page', { space_id: spaceId, title: 'Pinned' })
  const createdData = JSON.parse(
    (
      JSON.parse(created.text) as {
        result?: { content?: Array<{ text?: string }> }
      }
    ).result?.content?.[0]?.text ?? '{}',
  ) as { id?: string; updated_at?: string }
  const pageId = createdData.id ?? ''
  const updatedAt = createdData.updated_at ?? ''
  const updated = await call('update_page', {
    page_id: pageId,
    title: 'Pinned title',
    updated_at: updatedAt,
  })
  const updatedPayload = JSON.parse(updated.text) as {
    result?: { content?: Array<{ text?: string }> }
    error?: { message?: string }
  }
  const updatedData = JSON.parse(updatedPayload.result?.content?.[0]?.text ?? '{}') as {
    title?: string
  }
  const payloadStart = mcpSrc.indexOf('return {\n    id:')
  const payloadEnd = mcpSrc.indexOf('\n  }', payloadStart)
  const payloadKeys = [
    ...mcpSrc.slice(payloadStart, payloadEnd).matchAll(/\n\s+([a-z_]+):/g),
  ]
    .map((match) => match[1] ?? '')
    .sort()
  const liveKeys = Object.keys(
    JSON.parse(updatedPayload.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>,
  ).sort()
  expectLine('fc10_update_status', updated.status, pinnedUpdate)
  expectLine('fc10_update_title', updatedData.title === 'Pinned title', true)
  expectLine('fc10_update_body_match', liveKeys.join(',') === payloadKeys.join(','), true)
  expectLine(
    'fc10_update_new_deny',
    pinnedUpdate !== 403 &&
      pinnedUpdate !== 409 &&
      (updated.status === 403 || updated.status === 409),
    false,
  )
  const stale = await call('update_page', {
    page_id: pageId,
    title: 'Stale title',
    updated_at: updatedAt,
  })
  const staleBody = JSON.parse(stale.text) as { error?: { message?: string } }
  expectLine('fc10_conflict_status', stale.status, pinnedConflict)
  expectLine('fc10_conflict_message', staleBody.error?.message ?? '', 'Conflict')
  const saveBody = {
    pageId,
    title: 'Endpoint title',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'endpoint' }] }],
    },
  }
  const saved = await fetch(`${BASE}/api/pages/save`, {
    method: 'POST',
    headers: {
      cookie,
      origin: BASE,
      'content-type': 'application/json',
    },
    body: JSON.stringify(saveBody),
  })
  const savedText = await saved.text()
  expectLine('fc10_save_status', saved.status, pinnedSave)
  expectLine('fc10_save_body', savedText, '')
  expectLine(
    'fc10_save_new_deny',
    pinnedSave !== 403 && pinnedSave !== 409 && (saved.status === 403 || saved.status === 409),
    false,
  )
  const denied = await fetch(`${BASE}/api/pages/save`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(saveBody),
  })
  const deniedText = await denied.text()
  expectLine('fc10_forbidden_status', denied.status, pinnedForbidden)
  expectLine('fc10_forbidden_body', deniedText, JSON.stringify({ error: 'Forbidden' }))
  finish('fc10')
}

const recipes: Record<string, () => Promise<void>> = {
  fc1: recipeFc1,
  fc2: recipeFc2,
  fc3: recipeFc3,
  fc4: recipeFc4,
  fc5: recipeFc5,
  fc7: recipeFc7,
  fc8: recipeFc8,
  fc9: recipeFc9,
  fc10: recipeFc10,
}

const name = process.argv[2] ?? ''
const recipe = recipes[name]
if (!recipe) {
  console.error('usage: view-mode-fail.ts fc1|fc2|fc3|fc4|fc5|fc7|fc8|fc9|fc10')
  process.exit(2)
}

recipe().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'view-mode recipe failed')
  console.log(`37_${name}=fail`)
  process.exit(1)
})
