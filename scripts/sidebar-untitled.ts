import { chromium } from 'playwright'
import { assertLocalBaseUrl, submitAuthForm } from './verify-local.ts'

const BASE_URL = assertLocalBaseUrl(
  process.env.BASE_URL ?? 'http://127.0.0.1:3000',
)
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'sidebar-password-ok'

async function main() {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  let documentLoads = 0
  page.on('request', (request) => {
    if (
      request.resourceType() === 'document' &&
      request.frame() === page.mainFrame()
    ) {
      documentLoads += 1
    }
  })
  try {
    await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
    await page.locator('#name').fill('Sidebar Check')
    await page.locator('#email').fill(`sidebar.${stamp}@example.com`)
    await page.locator('#password').fill(PASSWORD)
    await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
    await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
    documentLoads = 0
    const before = page.url()
    await page.getByRole('button', { name: '+ New page' }).last().click()
    await page.waitForFunction(
      (href) => window.location.href !== href,
      before,
    )
    await page.locator('#page-title').waitFor()
    const title = await page.locator('#page-title').inputValue()
    const link = page.getByRole('link', { name: 'Untitled', exact: true })
    const listed = await link
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false)
    const className = listed ? ((await link.getAttribute('class')) ?? '') : ''
    const active = className.split(/\s+/).includes('act')
    const empty = await page
      .locator('.tree')
      .getByText('No pages', { exact: true })
      .isVisible()
      .catch(() => false)
    console.log(`editor_title=${title}`)
    console.log(`sidebar_untitled=${listed}`)
    console.log(`sidebar_active=${active}`)
    console.log(`sidebar_empty=${empty}`)
    console.log(`document_loads_after_create=${documentLoads}`)
    if (
      title !== 'Untitled' ||
      !listed ||
      !active ||
      empty ||
      documentLoads !== 0
    ) {
      throw new Error('open untitled page is missing from the sidebar')
    }
  } finally {
    await browser.close()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'sidebar check failed'
  console.error(message)
  process.exit(1)
})
