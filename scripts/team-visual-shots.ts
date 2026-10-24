import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page, type Request } from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3010'
const OUT = process.env.VISUAL_OUT ?? 'artifacts'
const written: string[] = []

type Mode = 'pass' | 'fail-tree'

function pngSize(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function requestBlob(request: Request) {
  return `${decodeURIComponent(request.url())} ${request.postData() ?? ''}`
}

function hasKey(blob: string, key: string) {
  return blob.includes(`"${key}"`)
}

function isServerFn(url: URL) {
  return url.pathname.includes('_serverFn') || url.pathname.includes('serverFn')
}

function classify(request: Request) {
  if (!isServerFn(new URL(request.url()))) return 'other'
  const blob = requestBlob(request)
  const method = request.method()
  if (hasKey(blob, 'mentionQuery')) return 'mentions'
  if (hasKey(blob, 'screen') && blob.includes('members')) return 'teamSettings'
  if (blob.includes('invitations')) return 'invitations'
  if (hasKey(blob, 'spaceId'))
    return method === 'GET' ? 'fetchPageTree' : 'createPage'
  return 'other'
}

async function shot(page: Page, width: number, screen: string, state: string) {
  const size = page.viewportSize()
  if (!size || size.width !== width) {
    throw new Error(
      `viewport width ${size?.width} !== ${width} for ${screen}-${state}`,
    )
  }
  const meta = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio,
  }))
  if (meta.dpr !== 1 || meta.innerWidth !== width) {
    throw new Error(`viewport ${meta.innerWidth} dpr ${meta.dpr}`)
  }
  const name = `${width}-${screen}-${state}.png`
  const path = join(OUT, name)
  await page.screenshot({
    path,
    fullPage: false,
    scale: 'css',
    animations: 'disabled',
  })
  const png = pngSize(await readFile(path))
  if (png.width !== width || png.height !== size.height) {
    throw new Error(
      `${name} is ${png.width}x${png.height}, expected ${width}x${size.height}`,
    )
  }
  console.log(`wrote ${name} ${png.width}x${png.height} dpr=${meta.dpr}`)
  written.push(name)
}

async function setViewport(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  )
}

async function waitReady(page: Page) {
  const res = await fetch(`${BASE_URL}/sign-in`)
  if (!res.ok && res.status >= 500) {
    throw new Error(`app not ready at ${BASE_URL}: ${res.status}`)
  }
  await page.goto(`${BASE_URL}/sign-in`, { waitUntil: 'networkidle' })
}

async function signUp(
  page: Page,
  name: string,
  email: string,
  password: string,
) {
  await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
  await page.locator('#name').fill(name)
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.locator('.app').waitFor()
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/sign-in`, { waitUntil: 'networkidle' })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
}

async function blur(page: Page) {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

async function apiSignUp(name: string, email: string, password: string) {
  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  })
  if (!response.ok)
    throw new Error(`sign-up ${name} failed: ${response.status}`)
}

async function acceptInvite(browser: Browser, email: string, password: string) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await signIn(page, email, password)
  await page.locator('.app').waitFor()
  await page.getByRole('link', { name: 'Profile' }).click()
  await page.getByRole('button', { name: 'Accept' }).click()
  await page.getByText('No invitations.').waitFor()
  await context.close()
}

async function expectCard(page: Page, top: number, width: number) {
  const box = await page.locator('.team-modal .card').boundingBox()
  if (!box) throw new Error('create team card missing')
  if (Math.abs(box.y - top) > 2 || Math.abs(box.width - width) > 2) {
    throw new Error(
      `card y=${box.y} width=${box.width}, expected y=${top} width=${width}`,
    )
  }
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const stamp = Date.now()
  const email = `ada.west.${stamp}@example.com`
  const password = 'visual-shots-password'
  const beaEmail = `bea.member.${stamp}@example.com`
  const caraEmail = `cara.north.${stamp}@example.com`
  let mode: Mode = 'pass'

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const page = await context.newPage()

  await page.route(isServerFn, async (route) => {
    const request = route.request()
    const kind = classify(request)
    if (mode === 'fail-tree' && kind === 'fetchPageTree') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      })
      return
    }
    await route.continue()
  })

  try {
    await waitReady(page)
    await setViewport(page, 1280, 800)
    await signUp(page, 'Ada West', email, password)
    await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
    await signOut(page)
    mode = 'fail-tree'
    await signIn(page, email, password)
    await page
      .getByRole('heading', { level: 2, name: "Couldn't load this space." })
      .waitFor()
    await page.getByText('Something went wrong.').waitFor()
    await page.getByRole('button', { name: 'Try again' }).waitFor()
    await page.getByRole('button', { name: 'Sign out' }).waitFor()
    await page.locator('.top b', { hasText: 'Pages' }).waitFor()
    await shot(page, 1280, 'space', 'error')
    await setViewport(page, 390, 844)
    await page.getByRole('button', { name: 'Try again' }).click({ trial: true })
    await page.getByRole('button', { name: 'Open pages' }).click()
    await page.locator('aside.side.open').waitFor()
    await page.getByRole('button', { name: 'Sign out' }).click({ trial: true })
    await shot(page, 390, 'space', 'error')
    await page.keyboard.press('Escape')
    await page.locator('aside.side.open').waitFor({ state: 'hidden' })
    await setViewport(page, 1280, 800)
    mode = 'pass'
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.getByRole('heading', { name: 'No pages yet' }).waitFor()

    await page.locator('.sw').click()
    await page.getByRole('menuitem', { name: 'Create team' }).click()
    await page.locator('#team-name').waitFor()
    await page.locator('.team-modal .scrim').waitFor()
    const focused = await page.evaluate(() => document.activeElement?.id ?? '')
    if (focused !== 'team-name') throw new Error(`create focus ${focused}`)
    await expectCard(page, 96, 380)
    await shot(page, 1280, 'create-team', 'rest')
    await setViewport(page, 390, 844)
    await expectCard(page, 16, 358)
    await shot(page, 390, 'create-team', 'rest')
    await setViewport(page, 1280, 800)
    await page.getByRole('button', { name: 'Create team' }).click()
    await page.getByText('Enter a team name.').waitFor()
    await blur(page)
    await shot(page, 1280, 'create-team', 'error')
    await page.locator('#team-name').fill('Northwind')
    await page.getByRole('button', { name: 'Create team' }).click()
    await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
    await page.locator('.team-modal').waitFor({ state: 'hidden' })

    await apiSignUp('Bea Member', beaEmail, password)
    await apiSignUp('Cara North', caraEmail, password)
    await page.locator('.sw').click()
    await page.getByRole('menuitem', { name: 'Team settings' }).click()
    await page.getByRole('heading', { name: 'Northwind' }).waitFor()
    await page.locator('#invite-email').fill(beaEmail)
    await page.getByRole('button', { name: 'Look up' }).click()
    await page.getByRole('button', { name: 'Send invite' }).waitFor()
    await page.locator('.found .me').waitFor()
    if ((await page.locator('.found .av').count()) !== 0) {
      throw new Error('lookup result uses a space avatar')
    }
    await blur(page)
    await shot(page, 1280, 'members', 'found')
    await page.getByRole('button', { name: 'Send invite' }).click()
    await page.getByText(beaEmail).waitFor()
    await acceptInvite(browser, beaEmail, password)

    await page.locator('#invite-email').fill(caraEmail)
    await page.getByRole('button', { name: 'Look up' }).click()
    await page.getByRole('button', { name: 'Send invite' }).click()
    await page.getByText(caraEmail).waitFor()
    await acceptInvite(browser, caraEmail, password)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByText('Bea Member').waitFor()
    await page.getByText('Cara North').waitFor()
    const beaRow = page.locator('.member-row', { hasText: 'Bea Member' })
    await beaRow.locator('.me').waitFor()
    if ((await beaRow.locator('.av').count()) !== 0) {
      throw new Error('member row uses a space avatar')
    }
    if ((await page.locator('.role-pill').count()) < 3) {
      throw new Error('members list is missing the owner or a second member')
    }
    await blur(page)
    await shot(page, 1280, 'members', 'owner')
    await setViewport(page, 390, 844)
    await shot(page, 390, 'members', 'owner')
    await setViewport(page, 1280, 800)

    await page.getByRole('button', { name: 'Delete team' }).click()
    await page
      .getByText("Delete Northwind and all its pages? This can't be undone.")
      .waitFor()
    const cancelFocused = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? '',
    )
    if (cancelFocused !== 'Cancel') {
      throw new Error(`delete focus ${cancelFocused}`)
    }
    const deleteFill = await page
      .locator('.btn.delete-team')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    if (deleteFill !== 'rgb(180, 35, 24)') {
      throw new Error(`delete fill ${deleteFill}`)
    }
    await shot(page, 1280, 'delete-team', 'confirm')
    await page.keyboard.press('Escape')
    await page.locator('.banner.confirm').waitFor({ state: 'hidden' })

    await page.locator('.sw').click()
    await page.getByRole('menuitem', { name: 'Northwind' }).click()
    await page.getByRole('button', { name: '+ New page' }).first().click()
    await page.locator('.doc-editor').waitFor()
    await page.locator('.doc-editor').click()
    await page.keyboard.type('@')
    const mentionList = page.getByRole('listbox', { name: 'Mention someone' })
    await mentionList.waitFor()
    await page.getByRole('option', { name: 'Ada West' }).waitFor()
    await page.getByRole('option', { name: 'Bea Member' }).waitFor()
    const active = mentionList.getByRole('option').first()
    const activeStyle = await active.evaluate((el) => ({
      className: el.className,
      background: getComputedStyle(el).backgroundColor,
      text: (el.textContent ?? '').trim(),
    }))
    if (
      !activeStyle.className.includes('on') ||
      activeStyle.background !== 'rgb(236, 235, 232)'
    ) {
      throw new Error(`active mention row ${JSON.stringify(activeStyle)}`)
    }
    await shot(page, 1280, 'mentions', 'list')
    await page.keyboard.press('Escape')

    await page.locator('.sw').focus()
    await page.locator('.sw').click()
    await page.getByRole('menu').waitFor()
    const northwind = page.getByRole('menuitem', { name: 'Northwind' })
    for (let i = 0; i < 6; i += 1) {
      const focusedRow = await northwind.evaluate(
        (el) => el === document.activeElement,
      )
      if (focusedRow) break
      await page.keyboard.press('Tab')
    }
    const focusStyle = await northwind.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        outline: style.outline,
        outlineOffset: style.outlineOffset,
        borderRadius: style.borderRadius,
        active: el === document.activeElement,
      }
    })
    console.log(`switcher_row_focus ${JSON.stringify(focusStyle)}`)
    if (
      !focusStyle.active ||
      focusStyle.outline !== 'rgb(15, 118, 110) solid 2px' ||
      focusStyle.outlineOffset !== '-2px'
    ) {
      throw new Error(`switcher focus ${JSON.stringify(focusStyle)}`)
    }
    await shot(page, 1280, 'switcher', 'focus-row')

    const expected = [
      '1280-create-team-error.png',
      '1280-create-team-rest.png',
      '1280-delete-team-confirm.png',
      '1280-members-found.png',
      '1280-members-owner.png',
      '1280-mentions-list.png',
      '1280-space-error.png',
      '1280-switcher-focus-row.png',
      '390-create-team-rest.png',
      '390-members-owner.png',
      '390-space-error.png',
    ]
    const names = [...written].sort()
    if (names.join('\n') !== expected.join('\n')) {
      throw new Error(`frames ${names.join(', ')}`)
    }
    console.log('png_dimensions_begin')
    for (const name of names) {
      const png = pngSize(await readFile(join(OUT, name)))
      console.log(`${name} ${png.width}x${png.height}`)
    }
    console.log('png_dimensions_end')
    console.log('team visual shots complete')
  } catch (error) {
    await page
      .screenshot({
        path: join(OUT, 'debug-fail.png'),
        fullPage: false,
        scale: 'css',
      })
      .catch(() => undefined)
    throw error
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
