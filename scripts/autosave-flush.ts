import { chromium } from 'playwright'
import { assertLocalBaseUrl, waitForClient } from './verify-local.ts'

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
  await waitForClient(page)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.locator('.app').waitFor()

  const emptyUrl = page.url()
  await page.getByRole('button', { name: '+ New page' }).last().click()
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
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  const afterReload = (await page.locator('.doc-editor').innerText()).trim()
  console.log(`typed=${typed}`)
  console.log(`after_reload_200ms=${afterReload}`)
  console.log(`reload_exact_match=${afterReload === typed}`)
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
  await page.getByRole('button', { name: '+ New page' }).last().click()
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
