import { execSync } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { assertLocalBaseUrl, submitAuthForm } from './verify-local.ts'

const base = assertLocalBaseUrl(process.env.BASE_URL ?? '')
const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
const out = join(process.env.VISUAL_OUT ?? 'artifacts', sha)
const proof = '/opt/cursor/artifacts'
const password = 'calendar-view-pass'

function pngSize(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function shot(page: Page, name: string) {
  const path = join(out, name)
  await page.screenshot({ path, animations: 'disabled', scale: 'css' })
  const size = pngSize(await readFile(path))
  const viewport = page.viewportSize()
  if (!viewport || size.width !== viewport.width) {
    throw new Error(
      `${name} is ${size.width}px wide, viewport is ${viewport?.width}`,
    )
  }
  await copyFile(path, join(proof, name))
  console.log(`wrote ${name} ${size.width}x${size.height}`)
}

async function elementShot(page: Page, selector: string, name: string) {
  const path = join(out, name)
  await page
    .locator(selector)
    .first()
    .screenshot({ path, animations: 'disabled' })
  await copyFile(path, join(proof, name))
  const size = pngSize(await readFile(path))
  console.log(`wrote ${name} ${size.width}x${size.height}`)
}

async function display(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => getComputedStyle(el).display)
}

async function signUp(page: Page) {
  const email = `calendar.${crypto.randomUUID()}@example.com`
  await page.goto(`${base}/sign-up`, { waitUntil: 'networkidle' })
  await page.locator('#name').fill('Ada Calendar')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.locator('.app').waitFor()
  await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
}

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  timezoneId: 'America/Los_Angeles',
})

try {
  await mkdir(out, { recursive: true })
  await mkdir(proof, { recursive: true })
  await page.clock.install({ time: new Date('2026-10-25T18:00:00Z') })
  await signUp(page)
  if ((await page.getByRole('link', { name: 'Calendar' }).count()) !== 0) {
    throw new Error('personal space shows a Calendar link')
  }

  await page.locator('.sw').click()
  await page.getByRole('menuitem', { name: 'Create team' }).click()
  await page.locator('#team-name').fill('Northwind')
  await page.getByRole('button', { name: 'Create team' }).click()
  await page.getByRole('heading', { name: 'No pages yet' }).waitFor()
  await page.getByRole('link', { name: 'Calendar' }).click()
  await page.locator('.cal-month-label', { hasText: 'October 2026' }).waitFor()
  await page.locator('.cal-grid .cal-empty').waitFor()
  const gridDisplay = await display(page, '.cal-grid')
  const agendaDisplay = await display(page, '.cal-agenda')
  const width = await page.evaluate(() => window.innerWidth)
  console.log(
    `viewport_width=${width} grid=${gridDisplay} agenda=${agendaDisplay}`,
  )
  if (gridDisplay === 'none') throw new Error('month grid hidden at 1280')
  if (agendaDisplay !== 'none') throw new Error('agenda visible at 1280')
  console.log('month_grid=visible')
  console.log('agenda_at_1280=hidden')
  await shot(page, '1280-calendar-empty.png')

  await page.locator('#event-title').fill('Site visit')
  await page.locator('#event-all-day').check()
  await page.locator('#event-start').fill('2026-10-30')
  await page.locator('#event-end').fill('2026-11-02')
  await page.locator('#event-note').fill('Bring the site plan.')
  await shot(page, '1280-calendar-add-panel.png')

  await page.getByRole('button', { name: 'Add event' }).click()
  const bars = page.locator('.cal-bar[data-crosses-month="true"]')
  await bars.first().waitFor()
  const count = await bars.count()
  let wide = false
  for (let index = 0; index < count; index += 1) {
    const start = Number(await bars.nth(index).getAttribute('data-start-col'))
    const end = Number(await bars.nth(index).getAttribute('data-end-col'))
    if (end > start) wide = true
  }
  if (!wide) throw new Error('month-crossing event is not one bar')
  console.log('month_crossing_bar=true')
  await shot(page, '1280-calendar-month.png')
  await elementShot(
    page,
    '.cal-week:has(.cal-bar[data-crosses-month="true"])',
    '1280-calendar-month-bar.png',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.cal-agenda').getByText('Site visit').waitFor()
  const agendaBox = await page.locator('.cal-agenda').boundingBox()
  if (!agendaBox || agendaBox.width < 300) {
    throw new Error(`agenda width ${agendaBox?.width ?? 0}`)
  }
  console.log(`agenda_width=${Math.round(agendaBox.width)}`)
  if ((await display(page, '.cal-grid')) !== 'none')
    throw new Error('month grid visible at 390')
  if ((await display(page, '.cal-agenda')) === 'none')
    throw new Error('agenda hidden at 390')
  console.log('agenda_at_390=visible')
  await shot(page, '390-calendar-agenda.png')
  console.log('calendar_view=pass')
} finally {
  await browser.close()
}
