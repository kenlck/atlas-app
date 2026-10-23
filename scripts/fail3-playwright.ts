import { chromium, type Request } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3010'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'visual-shots-password'

function requestBlob(request: Request) {
  return `${decodeURIComponent(request.url())} ${request.postData() ?? ''}`
}

function isServerFn(url: URL) {
  return url.pathname.includes('_serverFn') || url.pathname.includes('serverFn')
}

function isSave(request: Request) {
  if (!isServerFn(new URL(request.url()))) return false
  const blob = requestBlob(request)
  return blob.includes('"body"') && blob.includes('"pageId"')
}

async function main() {
  const stamp = Date.now()
  const email = `fail3.${stamp}@example.com`
  const typed = `Exact reload ${stamp}`
  const extra = ' kept'
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  let failSave = false

  await page.route(isServerFn, async (route) => {
    const request = route.request()
    if (failSave && isSave(request)) {
      console.log(`save_route status=500 url_path=${new URL(request.url()).pathname}`)
      await route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'Internal Server Error',
      })
      return
    }
    await route.continue()
  })

  await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
  await page.locator('#name').fill('Fail Three')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.locator('.app').waitFor()

  const emptyUrl = page.url()
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.waitForFunction((href) => window.location.href !== href, emptyUrl)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').click()
  await page.keyboard.type(typed)
  await page.getByText('Saved').waitFor()

  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  const afterReload = (await page.locator('.doc-editor').innerText()).trim()
  console.log(`typed=${typed}`)
  console.log(`after_reload=${afterReload}`)
  console.log(`reload_exact_match=${afterReload === typed}`)
  if (afterReload !== typed) {
    throw new Error('reload did not keep the exact typed text')
  }

  failSave = true
  await page.locator('.doc-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.type(extra)
  await page.getByText("Couldn't save.").waitFor()
  const banner = (await page.locator('.retry').innerText()).replace(/\s+/g, ' ').trim()
  const kept = (await page.locator('.doc-editor').innerText()).trim()
  console.log(`retry_banner=${banner}`)
  console.log(`text_after_500=${kept}`)
  console.log(`text_kept=${kept === `${typed}${extra}`}`)
  if (!banner.includes('Retry')) throw new Error('Retry banner missing')
  if (kept !== `${typed}${extra}`) throw new Error('typed text was not kept after the failed save')

  await browser.close()
  console.log('fail3 playwright complete')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
