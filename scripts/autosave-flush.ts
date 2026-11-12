import { chromium } from 'playwright'
import { assertLocalBaseUrl, clickNewDoc, submitAuthForm } from './verify-local.ts'

const BASE_URL = assertLocalBaseUrl(
  process.env.BASE_URL ?? 'http://127.0.0.1:3010',
)
const MARKER = `flush-${Date.now()}`
const PASSWORD = 'visual-shots-password'

async function main() {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  const email = `flush.${MARKER}@example.com`
  const typed = `keep-${MARKER}`

  await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
  await page.locator('#name').fill('Flush User')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.locator('.app').waitFor()

  const emptyUrl = page.url()
  await clickNewDoc(page)
  await page.waitForFunction((href) => window.location.href !== href, emptyUrl)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').click()
  await page.keyboard.type(typed)
  await page.waitForFunction(
    (value) =>
      (document.querySelector('.doc-editor')?.textContent ?? '').includes(
        value,
      ),
    typed,
  )
  const pageUrl = page.url()

  await page.waitForTimeout(200)
  // Block synchronous XHR so this reload uses sendBeacon or keepalive fetch.
  // Browsers send Origin on both. The save route rejects a missing Origin.
  const saves: Array<{ origin: string; status: number }> = []
  page.on('console', (message) => {
    const text = message.text()
    if (text === 'atlas-flush beacon') console.log('unload_transport=beacon')
    if (text === 'atlas-flush keepalive') console.log('unload_transport=keepalive')
  })
  await page.evaluate(() => {
    const proto = XMLHttpRequest.prototype
    const open = proto.open
    proto.open = function (
      this: XMLHttpRequest & { __atlasSync?: boolean },
      method: string,
      url: string | URL,
      async?: boolean,
    ) {
      this.__atlasSync = async === false
      return open.call(this, method, url, async ?? true)
    }
    const send = proto.send
    proto.send = function (
      this: XMLHttpRequest & { __atlasSync?: boolean },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      if (this.__atlasSync) throw new Error('synchronous XHR blocked')
      return send.call(this, body)
    }
    const beacon = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = (url, data) => {
      console.log('atlas-flush beacon')
      return beacon(url, data)
    }
    const origFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (init?.keepalive) console.log('atlas-flush keepalive')
      return origFetch(input, init)
    }
  })
  const client = await page.context().newCDPSession(page)
  await client.send('Network.enable')
  const saveIds = new Set<string>()
  const origins = new Map<string, string>()
  const statuses = new Map<string, number>()
  client.on('Network.requestWillBeSent', (event) => {
    if (event.request.url.includes('/api/pages/save')) saveIds.add(event.requestId)
  })
  client.on('Network.requestWillBeSentExtraInfo', (event) => {
    const headers = event.headers
    origins.set(event.requestId, headers.Origin || headers.origin || '')
  })
  client.on('Network.responseReceived', (event) => {
    if (event.response.url.includes('/api/pages/save')) {
      statuses.set(event.requestId, event.response.status)
    }
  })
  client.on('Network.responseReceivedExtraInfo', (event) => {
    if (typeof event.statusCode === 'number') statuses.set(event.requestId, event.statusCode)
  })
  console.log('unload_sync_xhr=blocked')
  await page.reload({ waitUntil: 'networkidle' })
  let afterReload = ''
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.locator('.doc-editor').waitFor()
    afterReload = (await page.locator('.doc-editor').innerText()).trim()
    if (afterReload === typed) break
    await page.reload({ waitUntil: 'networkidle' })
  }
  for (const id of saveIds) {
    saves.push({
      origin: origins.get(id) ?? '',
      status: statuses.get(id) ?? 0,
    })
  }
  const baseOrigin = new URL(BASE_URL).origin
  const originMatches =
    saves.length > 0 && saves.every((save) => save.origin === baseOrigin)
  const rejected = saves.some((save) => save.status === 403 || save.status === 400)
  const saveAccepted = originMatches && !rejected
  console.log(`unload_save_count=${saves.length}`)
  console.log(`unload_save_status=${saves.map((save) => save.status).join(',')}`)
  console.log(`unload_origin_matches=${originMatches}`)
  console.log(`unload_save_accepted=${saveAccepted}`)
  console.log(`typed=${typed}`)
  console.log(`after_reload_200ms=${afterReload}`)
  console.log(`reload_exact_match=${afterReload === typed}`)
  if (!saveAccepted) {
    throw new Error('unload flush did not send Origin and get accepted')
  }
  if (afterReload !== typed) {
    throw new Error('reload within 800ms lost the typed text')
  }

  await page.locator('.doc-editor').click()
  await page.keyboard.press('End')
  const second = `nav-${MARKER}`
  await page.keyboard.type(second)
  await page.waitForFunction(
    (value) =>
      (document.querySelector('.doc-editor')?.textContent ?? '').includes(
        value,
      ),
    second,
  )
  await page.waitForTimeout(200)
  const flushed = page.waitForResponse((response) => {
    const data = response.request().postData() ?? ''
    return response.ok() && data.includes(second)
  })
  await clickNewDoc(page)
  await flushed
  await page.waitForFunction((href) => window.location.href !== href, pageUrl)
  await page.locator('#page-title').waitFor()
  await page.goto(pageUrl, { waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  const afterNav = (await page.locator('.doc-editor').innerText()).trim()
  console.log(`after_navigate_away=${afterNav}`)
  console.log(`navigate_exact_match=${afterNav === `${typed}${second}`}`)
  if (afterNav !== `${typed}${second}`) {
    throw new Error('navigate away within 800ms lost the typed text')
  }

  await browser.close()
  console.log('autosave flush test complete')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
