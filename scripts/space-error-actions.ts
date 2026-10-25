import { chromium, type Page, type Request } from 'playwright'
import { assertLocalBaseUrl, submitAuthForm } from './verify-local.ts'

const BASE_URL = assertLocalBaseUrl(process.env.BASE_URL ?? 'http://127.0.0.1:3000')
const PASSWORD = 'space-error-password'
const ACTIONS = ['+ New page', 'Rename', 'Move', 'Archive'] as const
const MUTATIONS = new Set(['createPage', 'renamePage', 'movePage', 'archivePage'])

function classify(request: Request) {
  const url = request.url()
  if (!url.includes('_serverFn') && !url.includes('serverFn')) return 'other'
  const blob = `${decodeURIComponent(url)} ${request.postData() ?? ''}`
  const has = (key: string) => blob.includes(`"${key}"`)
  const method = request.method()
  if (has('body') && has('pageId')) return 'savePage'
  if (has('pageId') && has('title') && !has('body')) return 'renamePage'
  if (has('pageId') && has('parentId')) return 'movePage'
  if (has('pageId') && method === 'POST') return 'archivePage'
  if (has('pageId')) return 'fetchPage'
  if (has('spaceId') && method === 'POST') return 'createPage'
  if (has('spaceId')) return 'fetchPageTree'
  return 'other'
}

async function fillWhenHydrated(page: Page, email: string) {
  await page.locator('#email').waitFor()
  await page.waitForFunction(() => {
    const field = document.getElementById('email')
    if (!field) return false
    return Object.getOwnPropertyNames(field).some((key) => key.startsWith('__reactProps$'))
  })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
}

async function enabledButtons(page: Page) {
  const enabled: string[] = []
  for (const name of ACTIONS) {
    const buttons = page.getByRole('button', { name, exact: true })
    const count = await buttons.count()
    for (let index = 0; index < count; index += 1) {
      if (await buttons.nth(index).isEnabled()) enabled.push(name)
    }
  }
  return enabled
}

async function fire(
  page: Page,
  action: 'create' | 'rename' | 'archive' | 'move',
  pageId: string,
) {
  const seen: string[] = []
  const onRequest = (request: Request) => {
    const kind = classify(request)
    if (MUTATIONS.has(kind)) seen.push(kind)
  }
  page.on('request', onRequest)
  const invokeError = await page
    .evaluate(
      async ({ action, pageId }) => {
        const aside = document.querySelector('aside.side')
        if (!aside) throw new Error('sidebar missing')
        const key = Object.keys(aside).find((name) => name.startsWith('__reactFiber'))
        if (!key) throw new Error('sidebar fiber missing')
        let fiber = (aside as unknown as Record<string, { return?: unknown; memoizedProps?: Record<string, unknown> }>)[key]
        let props: Record<string, unknown> | null = null
        while (fiber) {
          const candidate = fiber.memoizedProps
          if (
            candidate &&
            typeof candidate.onCreate === 'function' &&
            typeof candidate.onRename === 'function' &&
            typeof candidate.onMove === 'function' &&
            typeof candidate.onArchive === 'function'
          ) {
            props = candidate
            break
          }
          fiber = fiber.return as typeof fiber
        }
        if (!props) throw new Error('action props missing')
        const call = props[
          action === 'create'
            ? 'onCreate'
            : action === 'rename'
              ? 'onRename'
              : action === 'archive'
                ? 'onArchive'
                : 'onMove'
        ] as (...args: unknown[]) => unknown
        if (action === 'create') await call(null)
        if (action === 'rename') await call(pageId, 'Renamed from error')
        if (action === 'archive') await call(pageId)
        if (action === 'move') call(pageId)
      },
      { action, pageId },
    )
    .then(() => '')
    .catch((error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : 'invoke failed'))
  if (invokeError) console.log(`${action}_invoke_error=${invokeError}`)
  if (action === 'move') {
    const opened = await page
      .getByRole('heading', { name: 'Move page' })
      .isVisible()
      .catch(() => false)
    console.log(`move_dialog=${opened}`)
    if (opened) {
      seen.push('moveDialog')
      await page.getByRole('button', { name: 'Top level', exact: true }).click()
      await page.waitForTimeout(400)
    }
  } else {
    await page.waitForTimeout(400)
  }
  page.off('request', onRequest)
  return seen
}

async function main() {
  const email = `space-error-${Date.now()}@example.com`
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  page.setDefaultTimeout(20000)
  let failTree = false
  await page.route(
    (url) => url.pathname.includes('_serverFn') || url.pathname.includes('serverFn'),
    async (route) => {
      if (failTree && classify(route.request()) === 'fetchPageTree') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Internal Server Error' }),
        })
        return
      }
      await route.continue()
    },
  )

  try {
    await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
    await page.locator('#name').waitFor()
    await page.waitForFunction(() => {
      const field = document.getElementById('name')
      if (!field) return false
      return Object.getOwnPropertyNames(field).some((key) => key.startsWith('__reactProps$'))
    })
    await page.locator('#name').fill('Space Error')
    await fillWhenHydrated(page, email)
    await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
    await page.getByRole('heading', { name: 'No pages yet' }).waitFor()

    const previous = page.url()
    await page.getByRole('button', { name: '+ New page' }).last().click()
    await page.waitForFunction((href) => window.location.href !== href, previous)
    await page.locator('#page-title').waitFor()
    const pageId = new URL(page.url()).pathname.split('/').pop() ?? ''
    if (!pageId) throw new Error('page id missing')
    console.log(`page_id_len=${pageId.length}`)

    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('heading', { name: 'Sign in' }).waitFor()
    failTree = true
    await page.goto(`${BASE_URL}/sign-in`, { waitUntil: 'networkidle' })
    await fillWhenHydrated(page, email)
    await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
    await page.getByRole('heading', { level: 1, name: "Couldn't load this space." }).waitFor()
    await page.locator('.tree .banner').waitFor()
    const banner = (await page.locator('.tree .banner').innerText()).trim()
    console.log(`error_h1=true`)
    console.log(`error_banner=${banner === "Couldn't load this space."}`)

    const buttons = await enabledButtons(page)
    console.log(`buttons_enabled=${buttons.length}`)
    console.log(`buttons=${JSON.stringify(buttons)}`)

    await page.locator('.tree .banner').click({ button: 'right' })
    const menu = await page.locator('.menu').allInnerTexts()
    const menuActions = menu.flatMap((text) =>
      ACTIONS.filter((name) => text.includes(name)),
    )
    console.log(`context_menu_actions=${JSON.stringify(menuActions)}`)

    const shortcutHits: string[] = []
    const onShortcut = (request: Request) => {
      const kind = classify(request)
      if (MUTATIONS.has(kind)) shortcutHits.push(kind)
    }
    page.on('request', onShortcut)
    await page.locator('.tree .banner').click()
    for (const key of ['n', 'Delete', 'Backspace', 'F2', 'Enter']) {
      await page.keyboard.press(`Control+${key}`)
    }
    await page.waitForTimeout(300)
    page.off('request', onShortcut)
    console.log(`shortcut_mutations=${JSON.stringify(shortcutHits)}`)

    const dragHandles = await page.locator('[draggable="true"]').count()
    console.log(`drag_handles=${dragHandles}`)

    const wired: string[] = []
    for (const action of ['rename', 'archive', 'move', 'create'] as const) {
      const hits = await fire(page, action, pageId)
      console.log(`wired_${action}=${JSON.stringify(hits)}`)
      wired.push(...hits)
    }

    const reachable =
      buttons.length > 0 ||
      menuActions.length > 0 ||
      shortcutHits.length > 0 ||
      dragHandles > 0 ||
      wired.length > 0
    console.log(`mutations_reachable=${reachable}`)
    if (!banner.includes("Couldn't load this space.")) {
      throw new Error('space error banner missing')
    }
    if (reachable) process.exitCode = 1
  } finally {
    await browser.close()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.split('\n')[0] : 'space-error recipe failed'
  console.error(message)
  process.exit(1)
})
