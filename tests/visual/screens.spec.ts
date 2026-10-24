import { existsSync } from 'node:fs'
import { expect, test, type Request } from '@playwright/test'
import { captureTableDateStates } from '../../scripts/table-date-states.ts'
import { submitAuthForm } from '../../scripts/verify-local.ts'

const PINNED =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea'
const FROZEN = new Date('2026-01-15T12:00:00Z')
const EMAIL = 'ada.baseline@example.com'
const PASSWORD = 'baseline-password'
const BASE = process.env.BASE_URL ?? ''

function blob(request: Request) {
  return `${decodeURIComponent(request.url())} ${request.postData() ?? ''}`
}

function kindOf(request: Request) {
  if (
    !request.url().includes('_serverFn') &&
    !request.url().includes('serverFn')
  )
    return 'other'
  const text = blob(request)
  if (text.includes('"body"') && text.includes('"pageId"')) return 'savePage'
  if (text.includes('"pageId"') && !text.includes('"title"')) return 'fetchPage'
  if (text.includes('"spaceId"') && request.method() === 'GET')
    return 'fetchPageTree'
  return 'other'
}

test.beforeAll(() => {
  if (
    process.env.ATLAS_PLAYWRIGHT_IMAGE !== PINNED ||
    !existsSync('/ms-playwright')
  ) {
    throw new Error(`toHaveScreenshot runs only inside ${PINNED}`)
  }
  let host = ''
  try {
    host = new URL(BASE).hostname.toLowerCase()
  } catch {
    host = ''
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('refusing non-local BASE_URL')
  }
})

test('1280 screens with seeded data', async ({ browser, request }) => {
  test.setTimeout(240000)
  const secret = process.env.ADMIN_API_SECRET ?? ''
  if (secret.length < 32) throw new Error('ADMIN_API_SECRET unset or short')

  const browserContext = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const page = await browserContext.newPage()
  await page.clock.install({ time: FROZEN })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  let mode = 'pass'
  const held: Array<() => void> = []
  const release = () => {
    for (const done of held.splice(0)) done()
  }
  await page.route(/_serverFn|serverFn/, async (route) => {
    const kind = kindOf(route.request())
    if (mode === 'hold-page' && kind === 'fetchPage') {
      await new Promise<void>((resolve) => {
        held.push(() => {
          void route.continue().then(
            () => resolve(),
            () => resolve(),
          )
        })
      })
      return
    }
    if (mode === 'hold-tree' && kind === 'fetchPageTree') {
      await new Promise<void>((resolve) => {
        held.push(() => {
          void route.continue().then(
            () => resolve(),
            () => resolve(),
          )
        })
      })
      return
    }
    if (mode === 'fail-page' && kind === 'fetchPage') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      })
      return
    }
    if (mode === 'fail-save' && kind === 'savePage') {
      await route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'Internal Server Error',
      })
      return
    }
    await route.continue()
  })

  async function shot(name: string, png?: Buffer) {
    if (png) {
      await expect(png).toMatchSnapshot(`${name}.png`)
      return
    }
    await expect(page).toHaveScreenshot(`${name}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await page.goto('/sign-in', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  await shot('sign-in-empty')
  await page.locator('#email').fill(EMAIL)
  await page.locator('#password').fill('wrong-password')
  await page.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.locator('.banner').waitFor()
  await shot('sign-in-error')

  await page.goto('/sign-up', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Create an account' }).waitFor()
  await shot('sign-up-empty')
  await page.locator('#name').fill('Ada')
  await page.locator('#email').fill('ada')
  await page.locator('#password').fill('short')
  await page.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.locator('.err').first().waitFor()
  await shot('sign-up-error')

  await page.goto('/forgot-password', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor()
  await shot('forgot-password')

  await page.goto('/sign-up', { waitUntil: 'networkidle' })
  await page.locator('#name').fill('Ada Baseline')
  await page.locator('#email').fill(EMAIL)
  await page.locator('#password').fill(PASSWORD)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
  await shot('space-empty')

  const spaceUrl = page.url()
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.waitForFunction((href) => window.location.href !== href, spaceUrl)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor .is-editor-empty').waitFor()

  await page.locator('#page-title').fill('Hello Atlas')
  await page.locator('#page-title').blur()
  await page.locator('.doc-editor').click()
  await page.keyboard.type('Bold me')
  await page.getByText('Saved', { exact: true }).waitFor()
  await shot('page-default')

  const pageUrl = page.url()
  const pageLink = page.locator('.tree a.it').filter({ hasText: 'Hello Atlas' })
  await page.goto(spaceUrl, { waitUntil: 'networkidle' })
  await pageLink.waitFor()
  mode = 'hold-page'
  await pageLink.click()
  await page.locator('.col .skel').first().waitFor()
  await shot('page-loading')
  mode = 'pass'
  release()
  await page.locator('#page-title').waitFor()

  await page.goto(spaceUrl, { waitUntil: 'networkidle' })
  mode = 'fail-page'
  await pageLink.click()
  await page
    .getByRole('heading', { name: "Couldn't load this page." })
    .waitFor()
  await page.getByRole('button', { name: 'Try again' }).waitFor()
  await shot('page-error')
  mode = 'pass'

  await page.goto(pageUrl, { waitUntil: 'networkidle' })
  await page.locator('.doc-editor').waitFor()
  mode = 'fail-save'
  await page.locator('.doc-editor').click()
  await page.keyboard.type(' more')
  await page.getByText("Couldn't save.").waitFor()
  await shot('page-retry')
  mode = 'pass'

  await captureTableDateStates(page, async (name, png) => {
    await shot(name, png)
  })

  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  mode = 'hold-tree'
  await page.locator('#email').fill(EMAIL)
  await page.locator('#password').fill(PASSWORD)
  await page.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.locator('.tree .skel').first().waitFor()
  await shot('space-loading')
  mode = 'pass'
  release()
  await page.locator('.tree a.it').first().waitFor()
  await browserContext.close()

  const reset = await request.post(`${BASE}/api/admin/reset-password`, {
    data: { email: EMAIL },
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
  })
  expect(reset.status()).toBe(200)
  const body = (await reset.json()) as { temporaryPassword?: string }
  const temporary = body.temporaryPassword ?? ''
  expect(temporary.length).toBe(24)

  const lockedContext = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const locked = await lockedContext.newPage()
  await locked.clock.install({ time: FROZEN })
  await locked.emulateMedia({ reducedMotion: 'reduce' })
  await locked.goto('/sign-in', { waitUntil: 'networkidle' })
  await locked.locator('#email').fill(EMAIL)
  await locked.locator('#password').fill(temporary)
  await locked.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
  await locked.getByRole('button', { name: 'Sign in' }).click()
  await locked.getByRole('heading', { name: 'Set a new password' }).waitFor()
  await locked.locator('#password').fill('new-password-ok')
  await locked.locator('#confirm').fill('different-password')
  await locked.getByRole('button', { name: 'Save password' }).click()
  await locked.getByText("Passwords don't match.").waitFor()
  await expect(locked).toHaveScreenshot('set-password-error.png', {
    animations: 'disabled',
    caret: 'hide',
  })
  await lockedContext.close()
})
