import { chromium, type Page, type Request } from 'playwright'
import { assertLocalBaseUrl, waitForClient } from './verify-local.ts'

const BASE_URL = assertLocalBaseUrl(
  process.env.BASE_URL ?? 'http://127.0.0.1:3010',
)
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'evidence-password-ok'

function swapIds(body: string, pageId: string, parentId: string) {
  return body
    .split(pageId)
    .join('__PAGE__')
    .split(parentId)
    .join(pageId)
    .split('__PAGE__')
    .join(parentId)
}

async function createNamed(page: Page, title: string) {
  const previous = page.url()
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.waitForFunction((href) => window.location.href !== href, previous)
  await page.locator('#page-title').waitFor()
  await page.locator('#page-title').fill(title)
  await page.locator('#page-title').blur()
  await page.locator('.tree a.it').filter({ hasText: title }).waitFor()
  const id = new URL(page.url()).pathname.split('/').pop() ?? ''
  if (!id) throw new Error(`missing id for ${title}`)
  console.log(`created title=${title} page_id=${id}`)
  return id
}

async function main() {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  let armed = false
  let move: { url: string; body: string } | null = null
  page.on('request', (request: Request) => {
    if (!armed || request.method() !== 'POST') return
    if (!request.url().includes('_serverFn')) return
    const body = request.postData() ?? ''
    if (!body.includes('"pageId"') || !body.includes('"parentId"')) return
    move = { url: request.url(), body }
  })

  await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
  await page.locator('#name').fill('Fail Four')
  await page.locator('#email').fill(`fail4.${stamp}@example.com`)
  await page.locator('#password').fill(PASSWORD)
  await waitForClient(page)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.locator('.app').waitFor()

  const parentId = await createNamed(page, 'Parent')
  const childId = await createNamed(page, 'Child')
  const childUrl = page.url()
  const spaceUrl = childUrl.replace(/\/p\/[^/]+$/, '')
  await page.goto(spaceUrl, { waitUntil: 'networkidle' })
  await page
    .locator('.tree a.it', { hasText: 'Child' })
    .click({ button: 'right' })
  await page.getByRole('button', { name: 'Move', exact: true }).click()
  await page.getByRole('heading', { name: 'Move page' }).waitFor()
  armed = true
  await page.getByRole('button', { name: 'Parent', exact: true }).click()
  await page.getByRole('link', { name: /▾\s*Parent/ }).waitFor()
  armed = false
  console.log('nested_child_under_parent=true')
  if (!move) throw new Error('move request was not observed')
  const captured: { url: string; body: string } = move

  async function replay(label: string, body: string) {
    const response = await page.request.post(captured.url, {
      data: body,
      headers: {
        origin: BASE_URL,
        'content-type': 'application/json',
        'x-tsr-serverFn': 'true',
      },
    })
    const text = (await response.text()).slice(0, 240)
    console.log(`${label}_status=${response.status()}`)
    console.log(`${label}_body=${text}`)
    if (response.status() !== 400)
      throw new Error(`${label} status ${response.status()}`)
  }

  await replay('move_under_child', swapIds(captured.body, childId, parentId))
  await replay('move_under_self', captured.body.split(parentId).join(childId))

  await page.goto(spaceUrl, { waitUntil: 'networkidle' })
  await page
    .locator('.tree a.it', { hasText: 'Parent' })
    .click({ button: 'right' })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page
    .locator('.tree a.it', { hasText: 'Child' })
    .waitFor({ state: 'detached' })
  const archived = await page.request.get(childUrl)
  const archivedText = await archived.text()
  console.log(`child_after_archive_status=${archived.status()}`)
  console.log(
    `child_after_archive_not_found=${archivedText.includes('Page not found.')}`,
  )
  if (archived.status() !== 404 || !archivedText.includes('Page not found.')) {
    throw new Error('archived child stayed reachable')
  }
  await browser.close()
  console.log('fail4 live complete')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'fail4 failed'
  console.error(message)
  process.exit(1)
})
