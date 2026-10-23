import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type Locator,
  type Page,
  type Request,
} from 'playwright'

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3010'
const OUT = process.env.VISUAL_OUT ?? 'artifacts'
const ADMIN_SECRET = process.env.ADMIN_API_SECRET ?? ''
const LONG_URL =
  'https://example.com/docs/this-is-a-very-long-unbroken-path-segment-that-should-wrap-inside-the-page-column-without-causing-horizontal-scroll-on-narrow-viewports-abcdefghijklmnopqrstuvwxyz0123456789'

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
  drawer: { width: 899, height: 800 },
  docked: { width: 900, height: 800 },
} as const

type Mode =
  | 'pass'
  | 'hold-page'
  | 'hold-tree'
  | 'fail-page'
  | 'fail-save'
  | 'hold-members'
  | 'fail-members'
  | 'hold-invites'
  | 'fail-invites'
  | 'hold-mentions'
  | 'fail-mentions'
  | 'fail-tree'

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
  if (blob.includes('lookup')) return 'lookup'
  if (hasKey(blob, 'body') && hasKey(blob, 'pageId')) return 'savePage'
  if (hasKey(blob, 'pageId') && hasKey(blob, 'title') && !hasKey(blob, 'body'))
    return 'renamePage'
  if (hasKey(blob, 'pageId') && !hasKey(blob, 'title')) return 'fetchPage'
  if (hasKey(blob, 'spaceId') && hasKey(blob, 'parentId')) return 'createPage'
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
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
  }))
  if (meta.dpr !== 1) {
    throw new Error(`DPR ${meta.dpr} !== 1 for ${screen}-${state}`)
  }
  if (meta.innerWidth !== width) {
    throw new Error(
      `innerWidth ${meta.innerWidth} !== ${width} for ${screen}-${state}`,
    )
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
  return path
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
  const app = page.locator('.app')
  const banner = page.locator('.banner')
  await Promise.race([
    app.waitFor({ state: 'visible' }),
    banner.waitFor({ state: 'visible' }),
  ])
  if (await banner.isVisible().catch(() => false)) {
    throw new Error(
      `sign-up failed: ${((await banner.textContent()) ?? '').trim()}`,
    )
  }
  await app.waitFor()
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

async function renameCurrent(page: Page, title: string) {
  const input = page.locator('#page-title')
  await input.waitFor()
  await page
    .locator('.col .skel')
    .first()
    .waitFor({ state: 'hidden' })
    .catch(() => undefined)
  await input.click()
  await input.fill(title)
  await page.waitForFunction((expected) => {
    const field = document.getElementById(
      'page-title',
    ) as HTMLInputElement | null
    return field?.value === expected
  }, title)
  await input.blur()
  await page.locator('.tree a.it').filter({ hasText: title }).waitFor()
}

async function createNamedPage(page: Page, title: string) {
  const previous = page.url()
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.waitForFunction((href) => window.location.href !== href, previous)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').waitFor()
  await renameCurrent(page, title)
}

async function logTitleLabel(page: Page, width: number) {
  const info = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label')).map((el) =>
      (el.textContent ?? '').trim(),
    )
    return { labels, hasTitleWord: /\bTITLE\b/.test(document.body.innerText) }
  })
  console.log(`title_label_${width} ${JSON.stringify(info)}`)
  if (
    info.hasTitleWord ||
    info.labels.some((label) => label.toUpperCase() === 'TITLE')
  ) {
    throw new Error(`TITLE label is visible at ${width}`)
  }
}

async function logDrawer(page: Page, width: number) {
  const info = await page.evaluate((viewport) => {
    const side = document.querySelector('.side.open')
    const scrim = document.querySelector('.scrim')
    const actual = side ? side.getBoundingClientRect().width : null
    const expected = Math.min(280, viewport * 0.85)
    const scrimBg = scrim ? getComputedStyle(scrim).backgroundColor : null
    return { actual, expected, scrimBg, open: Boolean(side) }
  }, width)
  console.log(`drawer_${width} ${JSON.stringify(info)}`)
  if (info.actual == null || Math.abs(info.actual - info.expected) > 1) {
    throw new Error(
      `drawer width at ${width} was ${info.actual}, expected ${info.expected}`,
    )
  }
}

async function printOverflow(page: Page, label: string) {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  console.log(
    `${label} document.documentElement.scrollWidth=${result.scrollWidth} innerWidth=${result.innerWidth} ok=${result.scrollWidth <= result.innerWidth}`,
  )
  if (result.scrollWidth > result.innerWidth) {
    throw new Error(
      `${label}: scrollWidth ${result.scrollWidth} > innerWidth ${result.innerWidth}`,
    )
  }
  const line = `${label} document.documentElement.scrollWidth=${result.scrollWidth} innerWidth=${result.innerWidth} ok=${result.scrollWidth <= result.innerWidth}\n`
  await writeFile(join(OUT, 'scrollwidth.log'), line)
}

const SHOT_SIZES = [
  [1280, 800],
  [390, 844],
  [899, 800],
  [900, 800],
] as const

async function shotOnly(
  page: Page,
  sizes: ReadonlyArray<readonly [number, number]>,
  screen: string,
  state: string,
) {
  for (const [width, height] of sizes) {
    await setViewport(page, width, height)
    await shot(page, width, screen, state)
  }
}

async function logFocus(locator: Locator, label: string) {
  const info = await locator.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      outline: style.outline,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      boxShadow: style.boxShadow,
    }
  })
  console.log(`${label}_focus ${JSON.stringify(info)}`)
}

async function logComputed(
  page: Page,
  selector: string,
  label: string,
  fields: string[],
) {
  const info = await page
    .locator(selector)
    .first()
    .evaluate((el, names) => {
      const style = getComputedStyle(el)
      const record: Record<string, string> = {}
      for (const name of names) {
        record[name] = style.getPropertyValue(name)
      }
      return record
    }, fields)
  console.log(`${label} ${JSON.stringify(info)}`)
}

async function shotSizes(page: Page, screen: string, state: string) {
  for (const [width, height] of SHOT_SIZES) {
    await setViewport(page, width, height)
    await shot(page, width, screen, state)
  }
}

async function showSidebar(page: Page, width: number) {
  if (width >= 900) {
    await page.locator('.side').waitFor()
    return
  }
  if (await page.locator('.side.open').count()) return
  await page.getByRole('button', { name: 'Open pages' }).click()
  await page.locator('.side.open').waitFor()
}

async function hideDrawer(page: Page) {
  if (!(await page.locator('.side.open').count())) return
  await page.keyboard.press('Escape')
  await page.locator('.side.open').waitFor({ state: 'hidden' })
}

async function openSwitcher(page: Page, width: number) {
  await showSidebar(page, width)
  const button = page.locator('.sw')
  if ((await button.getAttribute('aria-expanded')) !== 'true')
    await button.click()
  await page.getByRole('menu').waitFor()
}

async function dockAndCloseDrawer(page: Page) {
  await setViewport(page, 1280, 800)
  await hideDrawer(page)
}

async function clickSwitcherItem(page: Page, name: string) {
  await dockAndCloseDrawer(page)
  const button = page.locator('.sw')
  if ((await button.getAttribute('aria-expanded')) !== 'true')
    await button.click()
  await page.getByRole('menuitem', { name }).click()
}

function waitForSave(page: Page) {
  return page.waitForResponse((response) => {
    return classify(response.request()) === 'savePage' && response.ok()
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

async function captureTeamShots(input: {
  page: Page
  browser: Browser
  password: string
  stamp: number
  setMode: (mode: Mode) => void
  releaseHeld: () => void
}) {
  const { page, browser, password, stamp, setMode, releaseHeld } = input
  const beaEmail = `bea.member.${stamp}@example.com`
  await apiSignUp('Bea Member', beaEmail, password)
  await setViewport(page, 1280, 800)

  await page.locator('.sw').click()
  await page.getByRole('menuitem', { name: 'Create team' }).click()
  await page.getByRole('heading', { name: 'Create team' }).waitFor()
  await shotOnly(
    page,
    [
      [1280, 800],
      [390, 844],
    ],
    'create-team',
    'rest',
  )
  await setViewport(page, 1280, 800)
  await page.getByRole('button', { name: 'Create team' }).click()
  await page.getByText('Enter a team name.').waitFor()
  await logComputed(page, '.err', 'err_line', [
    'color',
    'font-size',
    'font-weight',
  ])
  await shotOnly(
    page,
    [
      [1280, 800],
      [390, 844],
    ],
    'create-team',
    'error',
  )
  await setViewport(page, 1280, 800)
  await page.locator('#team-name').fill('Northwind')
  const beforeTeam = page.url()
  await page.getByRole('button', { name: 'Create team' }).click()
  await page.waitForFunction(
    (href) => window.location.href !== href,
    beforeTeam,
  )
  await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
  const teamPath = new URL(page.url()).pathname.replace(/\/$/, '')
  const teamUrl = new URL(teamPath, BASE_URL).toString()
  const settingsUrl = new URL(`${teamPath}/settings`, BASE_URL).toString()

  setMode('hold-members')
  await clickSwitcherItem(page, 'Team settings')
  await page.locator('.doc .skel').first().waitFor()
  await shotSizes(page, 'members', 'loading')
  setMode('pass')
  releaseHeld()
  await page.getByRole('heading', { name: 'Northwind' }).waitFor()
  await page.getByText('No pending invites.').waitFor()
  await shotSizes(page, 'members', 'empty')

  await clickSwitcherItem(page, 'Northwind')
  await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
  setMode('fail-members')
  await clickSwitcherItem(page, 'Team settings')
  await page.getByText("Couldn't load members.").waitFor()
  await shotSizes(page, 'members', 'error')
  setMode('pass')
  await page.getByRole('button', { name: 'Retry' }).click()
  await page.getByRole('heading', { name: 'Northwind' }).waitFor()

  await page.locator('#invite-email').fill(`missing.${stamp}@example.com`)
  await page.getByRole('button', { name: 'Look up' }).click()
  await page.getByText('No account with that email.').waitFor()
  await shotSizes(page, 'members', 'no-account')

  await page.locator('#invite-email').fill(beaEmail)
  await page.getByRole('button', { name: 'Look up' }).click()
  await page.getByRole('button', { name: 'Send invite' }).waitFor()
  await page.getByText(beaEmail).waitFor()
  await shotSizes(page, 'members', 'found')
  await setViewport(page, 1280, 800)
  const sendInvite = page.getByRole('button', { name: 'Send invite' })
  await sendInvite.focus()
  await logFocus(sendInvite, 'send_invite')
  await shot(page, 1280, 'members', 'focus-send')
  await page.getByRole('button', { name: 'Send invite' }).click()
  await page.getByText('No pending invites.').waitFor({ state: 'hidden' })

  const beaContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const bea = await beaContext.newPage()
  await signIn(bea, beaEmail, password)
  await bea.locator('.app').waitFor()
  await bea.locator('.pending-dot').waitFor()
  await logComputed(bea, '.pending-dot', 'avatar_dot', [
    'width',
    'height',
    'background-color',
    'box-shadow',
    'border',
  ])
  await shotSizesPreparedDot(bea)
  await setViewport(bea, 1280, 800)
  await hideDrawer(bea)
  await bea.getByRole('link', { name: 'Profile' }).click()
  await bea.getByRole('heading', { name: 'Invitations' }).waitFor()
  await bea.getByRole('button', { name: 'Accept' }).waitFor()
  await shotSizes(bea, 'invitations', 'pending')
  await setViewport(bea, 1280, 800)
  await hideDrawer(bea)
  const accept = bea.getByRole('button', { name: 'Accept' })
  await accept.focus()
  await logFocus(accept, 'accept')
  await shot(bea, 1280, 'invitations', 'focus-accept')
  const decline = bea.getByRole('button', { name: 'Decline' })
  await decline.focus()
  await logFocus(decline, 'decline')
  await shot(bea, 1280, 'invitations', 'focus-decline')
  await bea.getByRole('button', { name: 'Accept' }).click()
  await bea.getByText('No invitations.').waitFor()
  await bea.locator('.pending-dot').waitFor({ state: 'detached' })
  await shot(bea, 1280, 'avatar', 'clear')
  await bea.locator('.sw').click()
  await bea.getByRole('menuitem', { name: 'Northwind' }).click()
  await bea.getByRole('heading', { name: 'No pages yet' }).waitFor()
  await bea.locator('.sw').click()
  await bea.getByRole('menuitem', { name: 'Team settings' }).click()
  await bea.locator('[data-role="member"]').waitFor()
  if ((await bea.getByRole('button', { name: 'Look up' }).count()) !== 0) {
    throw new Error('member view shows invite controls')
  }
  if ((await bea.getByRole('button', { name: 'Delete team' }).count()) !== 0) {
    throw new Error('member view shows delete')
  }
  await shotSizes(bea, 'members', 'member')
  await beaContext.close()

  const caraEmail = `cara.north.${stamp}@example.com`
  await apiSignUp('Cara North', caraEmail, password)
  await page.goto(settingsUrl, { waitUntil: 'networkidle' })
  await page.locator('#invite-email').fill(caraEmail)
  await page.getByRole('button', { name: 'Look up' }).click()
  await page.getByRole('button', { name: 'Send invite' }).click()
  await page.getByText(caraEmail).waitFor()
  const caraContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const cara = await caraContext.newPage()
  await signIn(cara, caraEmail, password)
  await cara.locator('.app').waitFor()
  await cara.getByRole('link', { name: 'Profile' }).click()
  await cara.getByRole('button', { name: 'Accept' }).click()
  await cara.getByText('No invitations.').waitFor()
  await caraContext.close()
  await page.goto(settingsUrl, { waitUntil: 'networkidle' })
  await page.getByText('Cara North').waitFor()
  await page.getByText('Bea Member').waitFor()
  if ((await page.locator('.role-pill').count()) < 3) {
    throw new Error('members list is missing the owner or a second member')
  }
  await shotSizes(page, 'members', 'owner')
  await setViewport(page, 1280, 800)
  const lookup = page.getByRole('button', { name: 'Look up' })
  await lookup.focus()
  await logFocus(lookup, 'lookup')
  await shot(page, 1280, 'members', 'focus-lookup')
  await page.getByRole('button', { name: 'Delete team' }).click()
  await page.getByText('Delete this team and its pages?').waitFor()
  await shot(page, 1280, 'delete-team', 'confirm')
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Northwind' }).waitFor()

  await page.goto(teamUrl, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '+ New page' }).first().click()
  await page.locator('.doc-editor').waitFor()
  await page.locator('.doc-editor').click()
  await page.keyboard.type('@')
  const mentionList = page.getByRole('listbox', { name: 'Mention someone' })
  await mentionList.waitFor()
  await page.getByRole('option', { name: 'Ada West' }).waitFor()
  await page.getByRole('option', { name: 'Bea Member' }).waitFor()
  const optionText = (await page.getByRole('option').allTextContents()).join(
    '\n',
  )
  if (optionText.includes('@') || optionText.includes(beaEmail)) {
    throw new Error(`mention list leaked an email: ${optionText}`)
  }
  if (!optionText.includes('Bea Member') || !optionText.includes('Ada West')) {
    throw new Error(`mention list missing teammates: ${optionText}`)
  }
  await shotSizes(page, 'mentions', 'list')
  await setViewport(page, 1280, 800)
  if (!(await mentionList.isVisible())) {
    await page.locator('.doc-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.type('@')
    await mentionList.waitFor()
    await page.getByRole('option', { name: 'Bea Member' }).waitFor()
  }
  const mentionSaved = waitForSave(page)
  await page.getByRole('option', { name: 'Bea Member' }).click()
  await page.locator('.mention').first().waitFor()
  const chip = (
    (await page.locator('.mention').first().innerText()) ?? ''
  ).trim()
  if (chip.includes('@') || chip.includes(beaEmail))
    throw new Error(`chip leaked email: ${chip}`)
  await mentionSaved
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.mention:not(.former)').first().waitFor()
  await page.locator('#page-title').click()
  await logComputed(page, '.mention:not(.former)', 'mention_chip', [
    'background-color',
    'color',
    'height',
    'padding',
    'border-radius',
  ])
  await shotSizes(page, 'mentions', 'chip')

  await page.locator('.doc-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' @zzz')
  await page.getByText('No matches.').waitFor()
  await shotSizes(page, 'mentions', 'empty')
  await page.keyboard.press('Escape')

  await setViewport(page, 1280, 800)
  await page.locator('.doc-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' ')
  const trailSaved = waitForSave(page)
  setMode('hold-mentions')
  await page.keyboard.type('@')
  await page.locator('.mention-list .skel').waitFor()
  await shotSizes(page, 'mentions', 'loading')
  setMode('pass')
  releaseHeld()
  await page.keyboard.press('Escape')
  await trailSaved

  await setViewport(page, 1280, 800)
  await page.locator('.doc-editor').click()
  await page.keyboard.press('End')
  setMode('fail-mentions')
  await page.keyboard.type(' @')
  await page.getByText("Couldn't load mentions.").waitFor()
  await page.getByRole('button', { name: 'Retry' }).waitFor()
  await shot(page, 1280, 'mentions', 'error')
  setMode('pass')
  await page.keyboard.press('Escape')

  const mentionedUrl = page.url()
  await page.goto(settingsUrl, { waitUntil: 'networkidle' })
  const beaRow = page.locator('.member-row', { hasText: 'Bea Member' })
  await beaRow.getByRole('button', { name: 'Remove' }).click()
  await beaRow.waitFor({ state: 'detached' })
  await page.goto(mentionedUrl, { waitUntil: 'networkidle' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.mention.former').waitFor()
  const former = (
    (await page.locator('.mention.former').innerText()) ?? ''
  ).trim()
  if (former.includes('@') || former.includes(beaEmail))
    throw new Error(`former chip leaked email: ${former}`)
  await logComputed(page, '.mention.former', 'mention_chip_former', [
    'background-color',
    'color',
    'height',
    'padding',
    'border-radius',
  ])
  await shotSizes(page, 'mentions', 'former')

  await shotSizesPrepared(page, 'switcher', 'open', async (width) => {
    await openSwitcher(page, width)
    await page.getByRole('menuitem', { name: 'Team settings' }).waitFor()
  })
  await setViewport(page, 1280, 800)
  await openSwitcher(page, 1280)
  const switcherRow = page.getByRole('menuitem', { name: 'Northwind' })
  await switcherRow.focus()
  await logFocus(switcherRow, 'switcher_row')
  await shot(page, 1280, 'switcher', 'focus-row')
  await page.keyboard.press('Escape')
  await hideDrawer(page)

  setMode('hold-invites')
  await dockAndCloseDrawer(page)
  await page.getByRole('link', { name: 'Profile' }).click()
  await page.locator('.doc .skel').first().waitFor()
  await shotSizes(page, 'invitations', 'loading')
  setMode('pass')
  releaseHeld()
  await page.getByText('No invitations.').waitFor()
  await shotSizes(page, 'invitations', 'empty')

  await clickSwitcherItem(page, 'Northwind')
  await page.getByRole('heading', { name: 'Select a page' }).waitFor()
  setMode('fail-invites')
  await dockAndCloseDrawer(page)
  await page.getByRole('link', { name: 'Profile' }).click()
  await page.getByText("Couldn't load invitations.").waitFor()
  await shotSizes(page, 'invitations', 'error')
  setMode('pass')
  await page.getByRole('button', { name: 'Retry' }).click()
  await page.getByText('No invitations.').waitFor()
  console.log('team visual shots complete')
}

async function shotSizesPrepared(
  page: Page,
  screen: string,
  state: string,
  prepare: (width: number) => Promise<void>,
) {
  for (const [width, height] of SHOT_SIZES) {
    await setViewport(page, width, height)
    await prepare(width)
    await shot(page, width, screen, state)
  }
}

async function shotSizesPreparedDot(page: Page) {
  await shotSizesPrepared(page, 'avatar', 'pending', async (width) => {
    await showSidebar(page, width)
    await page.locator('.pending-dot').waitFor()
  })
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const stamp = Date.now()
  const email = `ada.west.${stamp}@example.com`
  const password = 'visual-shots-password'
  const resetEmail = `reset.${stamp}@example.com`
  let mode: Mode = 'pass'

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    viewport: VIEWPORTS.desktop,
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  const held: Array<() => void> = []
  const releaseHeld = () => {
    const batch = held.splice(0)
    for (const release of batch) release()
  }

  await page.route(isServerFn, async (route) => {
    const request = route.request()
    const kind = classify(request)
    console.log('serverFn', request.method(), kind, mode, request.url())
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
    if (mode === 'hold-members' && kind === 'teamSettings') {
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
    if (mode === 'fail-members' && kind === 'teamSettings') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      })
      return
    }
    if (mode === 'hold-invites' && kind === 'invitations') {
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
    if (mode === 'fail-invites' && kind === 'invitations') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      })
      return
    }
    if (mode === 'hold-mentions' && kind === 'mentions') {
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
    if (mode === 'fail-mentions' && kind === 'mentions') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        headers: { 'x-tss-serialized': 'true' },
        body: JSON.stringify({
          t: 10,
          i: 0,
          p: {
            k: ['error'],
            v: [
              {
                t: 25,
                i: 1,
                s: { message: { t: 1, s: 'Internal Server Error' } },
                c: '$TSR/Error',
              },
            ],
          },
          o: 0,
        }),
      })
      return
    }
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

    await page.goto(`${BASE_URL}/sign-in`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Sign in' }).waitFor()
    await shot(page, 1280, 'sign-in', 'empty')

    await page.locator('#email').focus()
    await shot(page, 1280, 'sign-in', 'focus-input')

    await page.getByRole('button', { name: 'Sign in' }).focus()
    await shot(page, 1280, 'sign-in', 'focus-button')
    const buttonFocus = await page
      .getByRole('button', { name: 'Sign in' })
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          outline: style.outline,
          outlineOffset: style.outlineOffset,
          boxShadow: style.boxShadow,
        }
      })
    console.log(`button_focus ${JSON.stringify(buttonFocus)}`)

    await page.locator('#email').fill(email)
    await page.locator('#password').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.locator('.banner').waitFor()
    await shot(page, 1280, 'sign-in', 'wrong-credentials')

    await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Create an account' }).waitFor()
    await shot(page, 1280, 'sign-up', 'empty')

    await page.locator('#name').fill('Ada')
    await page.locator('#email').fill('ada')
    await page.locator('#password').fill('short')
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.locator('.err').first().waitFor()
    await shot(page, 1280, 'sign-up', 'validation')
    const signupHint = await page.locator('.hint').count()
    const signupErrors = await page.locator('.err').allTextContents()
    console.log(`signup_hint_count=${signupHint}`)
    console.log(
      `signup_errors=${JSON.stringify(signupErrors.map((text) => text.trim()))}`,
    )
    if (signupHint !== 0)
      throw new Error('sign-up hint is still visible beside the error')

    await page.goto(`${BASE_URL}/forgot-password`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor()
    await shot(page, 1280, 'forgot-password', 'note')

    if (ADMIN_SECRET.length >= 32) {
      await signUp(page, 'Reset User', resetEmail, password)
      await signOut(page)
      const resetRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ADMIN_SECRET}`,
          'content-type': 'application/json',
          'x-forwarded-for': `127.0.0.${(stamp % 200) + 1}`,
        },
        body: JSON.stringify({ email: resetEmail }),
      })
      if (!resetRes.ok) {
        throw new Error(`admin reset failed: ${resetRes.status}`)
      }
      const resetBody = (await resetRes.json()) as {
        temporaryPassword?: string
      }
      const temporaryPassword = resetBody.temporaryPassword
      if (!temporaryPassword)
        throw new Error('admin reset missing temporaryPassword')
      await signIn(page, resetEmail, temporaryPassword)
      await page.getByRole('heading', { name: 'Set a new password' }).waitFor()
      await page.locator('#password').fill('new-password-ok')
      await page.locator('#confirm').fill('different-password')
      await page.getByRole('button', { name: 'Save password' }).click()
      await page.getByText("Passwords don't match.").waitFor()
      await shot(page, 1280, 'set-password', 'mismatch')
      await page.getByRole('button', { name: 'Sign out' }).click()
      await page.getByRole('heading', { name: 'Sign in' }).waitFor()
    } else {
      console.log(
        'ADMIN_API_SECRET unset or short; skipping set-password mismatch shot',
      )
    }

    await signUp(page, 'Ada West', email, password)
    await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
    await page.locator('.me').waitFor()
    await shot(page, 1280, 'space', 'empty')
    await shotOnly(page, [[390, 844]], 'space', 'empty')
    await setViewport(page, 1280, 800)

    const emptyUrl = page.url()
    await page.getByRole('button', { name: '+ New page' }).last().click()
    await page.waitForFunction(
      (href) => window.location.href !== href,
      emptyUrl,
    )
    await page.locator('#page-title').waitFor()
    await page.locator('.doc-editor .is-editor-empty').waitFor()
    await shot(page, 1280, 'page', 'empty-body')
    await logTitleLabel(page, 1280)
    await renameCurrent(page, 'One')

    await createNamedPage(page, 'Two')
    await page.locator('.doc-editor').click()
    await page.keyboard.type('Hello Atlas')
    await page.getByText('Saved').waitFor()

    const oneHref = await page
      .locator('.tree a.it')
      .filter({ hasText: 'One' })
      .getAttribute('href')
    if (!oneHref) throw new Error('missing One href')
    await page.goto(new URL(oneHref, BASE_URL).toString(), {
      waitUntil: 'networkidle',
    })
    await page.locator('#page-title').waitFor()
    await page.locator('.tree a.it').filter({ hasText: 'Two' }).waitFor()

    mode = 'hold-page'
    await page.locator('.tree a.it').filter({ hasText: 'Two' }).click()
    await page.locator('.col .skel').first().waitFor()
    await shot(page, 1280, 'page', 'loading')
    mode = 'pass'
    releaseHeld()
    await page.locator('#page-title').waitFor()

    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('heading', { name: 'Sign in' }).waitFor()
    mode = 'hold-tree'
    await signIn(page, email, password)
    await page.locator('.tree .skel').first().waitFor()
    await shot(page, 1280, 'space', 'loading')
    mode = 'pass'
    releaseHeld()
    await page.locator('.tree a.it').first().waitFor()

    await signOut(page)
    await setViewport(page, 390, 844)
    mode = 'hold-tree'
    await signIn(page, email, password)
    await page.locator('.tree .skel').first().waitFor({ state: 'attached' })
    await shot(page, 390, 'space', 'loading')
    mode = 'pass'
    releaseHeld()
    await setViewport(page, 1280, 800)
    await page.locator('.tree a.it').first().waitFor()

    await page.goto(new URL(oneHref, BASE_URL).toString(), {
      waitUntil: 'networkidle',
    })
    await page.locator('#page-title').waitFor()

    mode = 'fail-page'
    await page.locator('.tree a.it').filter({ hasText: 'Two' }).click()
    await page
      .getByRole('heading', { name: "Couldn't load this page." })
      .waitFor()
    await page.getByRole('button', { name: 'Try again' }).waitFor()
    const pageError = await page.evaluate(() => ({
      topBar: Boolean(document.querySelector('.top')),
      copy: document.querySelector('.nf .empty')?.textContent?.trim() ?? '',
      tryAgain: Boolean(document.querySelector('.nf .btn.secondary')),
    }))
    console.log(`page_error ${JSON.stringify(pageError)}`)
    await shot(page, 1280, 'page', 'error')
    mode = 'pass'
    await page.goto(new URL(oneHref, BASE_URL).toString(), {
      waitUntil: 'networkidle',
    })
    await page.locator('#page-title').waitFor()

    mode = 'fail-save'
    await page.locator('.doc-editor').click()
    await page.keyboard.type(' more text')
    await page.getByText("Couldn't save.").waitFor()
    await shot(page, 1280, 'page', 'autosave-retry')
    mode = 'pass'
    await page.getByRole('button', { name: 'Retry' }).click()
    await page.getByText('Saved').waitFor()

    await page.locator('.tree a.it').filter({ hasText: 'Two' }).click()
    await page.locator('#page-title').waitFor()
    await page.locator('.doc-editor').waitFor()
    await page.locator('.doc-editor').click()
    await page.keyboard.type('Bold me')
    await page.keyboard.press('ControlOrMeta+A')
    await page.locator('.tool button:has(b)').click()
    await page.locator('.tool button.on:has(b)').waitFor()
    await shot(page, 1280, 'editor', 'bold-active')
    const selectionPaint = await page.evaluate(() => {
      const root = document.querySelector('.ProseMirror') as HTMLElement | null
      root?.focus()
      document.execCommand('selectAll')
      const el =
        document.querySelector('.doc-editor p') ??
        document.querySelector('.doc-editor')
      return {
        bg: el ? getComputedStyle(el, '::selection').backgroundColor : '',
        text: window.getSelection()?.toString() ?? '',
        token: getComputedStyle(document.documentElement)
          .getPropertyValue('--selection')
          .trim(),
        active: document.activeElement?.className ?? '',
      }
    })
    console.log(`selection_paint ${JSON.stringify(selectionPaint)}`)
    if (
      selectionPaint.text.length === 0 ||
      selectionPaint.bg !== 'rgb(205, 231, 226)' ||
      selectionPaint.token !== '#cde7e2'
    ) {
      throw new Error(
        `selection color ${selectionPaint.bg} token ${selectionPaint.token}`,
      )
    }
    await shot(page, 1280, 'editor', 'selection')

    await page.getByRole('button', { name: 'Text style' }).click()
    await page.getByRole('listbox').waitFor()
    await page.getByRole('option', { selected: true }).waitFor()
    const styleCurrent = await page
      .getByRole('option', { selected: true })
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          text: (el.textContent ?? '').trim(),
          className: el.className,
          background: style.backgroundColor,
          color: style.color,
        }
      })
    console.log(`style_menu_current ${JSON.stringify(styleCurrent)}`)
    await shot(page, 1280, 'editor', 'style-menu')
    await page.locator('#page-title').click()
    await page.getByRole('listbox').waitFor({ state: 'hidden' })

    await page.locator('.doc-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Visit Atlas')
    await page.getByText('Visit Atlas').click({ clickCount: 3 })
    page.once('dialog', (dialog) => {
      void dialog.accept('https://example.com/atlas')
    })
    await page.getByRole('button', { name: 'Link' }).click()
    await page.locator('.doc-editor a').waitFor()
    const linkDecoration = await page
      .locator('.doc-editor a')
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          textDecorationLine: style.textDecorationLine,
          textDecorationThickness: style.textDecorationThickness,
          textDecorationColor: style.textDecorationColor,
          textUnderlineOffset: style.textUnderlineOffset,
        }
      })
    console.log(`link_decoration ${JSON.stringify(linkDecoration)}`)
    await page.locator('#page-title').click()
    await shot(page, 1280, 'page', 'link')

    await setViewport(page, 390, 844)
    await page.getByRole('button', { name: 'Open pages' }).waitFor()
    await logTitleLabel(page, 390)
    await shot(page, 390, 'page', 'title')
    await shot(page, 390, 'page', 'drawer-closed')

    await page.getByRole('button', { name: 'Open pages' }).click()
    await page.locator('.side.open').waitFor()
    await page.locator('.scrim').waitFor()
    await logDrawer(page, 390)
    await shot(page, 390, 'page', 'drawer-open')
    await page
      .locator('.scrim')
      .click({ position: { x: 370, y: 24 }, force: true })
    await page.locator('.side.open').waitFor({ state: 'hidden' })
    console.log('drawer_390_scrim_tap_closed=true')
    await page.getByRole('button', { name: 'Open pages' }).click()
    await page.locator('.side.open').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.side.open').waitFor({ state: 'hidden' })
    console.log('drawer_390_esc_closed=true')

    await page.locator('.tool').evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await shot(page, 390, 'page', 'toolbar-scroll')
    await page.locator('.tool').evaluate((el) => {
      el.scrollLeft = 0
    })

    await page.locator('.doc-editor').click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(LONG_URL)
    await page.keyboard.press('Enter')
    await page.getByText(LONG_URL).waitFor()
    await printOverflow(page, '390-page-long-url')
    await shot(page, 390, 'page', 'long-url')

    await setViewport(page, 899, 800)
    await page.getByRole('button', { name: 'Open pages' }).waitFor()
    await shot(page, 899, 'page', 'drawer')
    await page.getByRole('button', { name: 'Open pages' }).click()
    await page.locator('.side.open').waitFor()
    await page.locator('.scrim').waitFor()
    await logDrawer(page, 899)
    await shot(page, 899, 'page', 'drawer-open')
    await page
      .locator('.scrim')
      .click({ position: { x: 870, y: 24 }, force: true })
    await page.locator('.side.open').waitFor({ state: 'hidden' })
    console.log('drawer_899_scrim_tap_closed=true')
    await page.getByRole('button', { name: 'Open pages' }).click()
    await page.locator('.side.open').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.side.open').waitFor({ state: 'hidden' })
    console.log('drawer_899_esc_closed=true')

    await setViewport(page, 900, 800)
    await page
      .getByRole('button', { name: 'Open pages' })
      .waitFor({ state: 'hidden' })
    await page.locator('.side').waitFor()
    await shot(page, 900, 'page', 'sidebar-docked')
    await setViewport(page, 1280, 800)
    await signOut(page)
    mode = 'fail-tree'
    await signIn(page, email, password)
    await page.getByText("Couldn't load this space.").waitFor()
    await page.getByRole('button', { name: 'Retry' }).waitFor()
    await shot(page, 1280, 'space', 'error')
    mode = 'pass'
    await page.getByRole('button', { name: 'Retry' }).click()
    await page.locator('button.sw').waitFor()
    await page.locator('.tree a.it').first().waitFor()
    await captureTeamShots({
      page,
      browser,
      password,
      stamp,
      setMode: (next) => {
        mode = next
      },
      releaseHeld,
    })
    const pngs = (await readdir(OUT))
      .filter((name) => name.endsWith('.png') && name !== 'debug-fail.png')
      .sort()
    console.log('png_dimensions_begin')
    for (const name of pngs) {
      const png = pngSize(await readFile(join(OUT, name)))
      console.log(`${name} ${png.width}x${png.height}`)
    }
    console.log('png_dimensions_end')
    console.log('visual shots complete')
  } catch (error) {
    const tree = await page
      .locator('.tree')
      .innerText()
      .catch(() => '')
    console.log('debug url', page.url())
    console.log('debug tree', JSON.stringify(tree))
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
