import { chromium, type Page } from 'playwright'
import { assertLocalBaseUrl, submitAuthForm } from './verify-local.ts'

const BASE_URL = assertLocalBaseUrl(
  process.env.BASE_URL ?? 'http://127.0.0.1:3000',
)
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'date-paste-password-ok'

const HTML = [
  '<p>Ship on <span data-date="2026-03-04T09:00:00Z">Mar 4, 9am</span> please</p>',
  '<p>Due <span data-date="Friday">this Friday</span>.</p>',
  '<p>Skip <span data-date="2026-02-31">Feb 31</span>.</p>',
  '<p>On <span data-date="2026-01-15">Jan 15, 2026</span>.</p>',
].join('')

async function pasteHtml(page: Page, html: string) {
  await page.locator('.ProseMirror').evaluate((el, payload) => {
    const data = new DataTransfer()
    data.setData('text/html', payload)
    data.setData('text/plain', 'plain fallback')
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'clipboardData', { value: data })
    el.dispatchEvent(event)
  }, html)
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
  try {
    await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
    await page.locator('#name').fill('Date Paste')
    await page.locator('#email').fill(`datepaste.${stamp}@example.com`)
    await page.locator('#password').fill(PASSWORD)
    await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
    await page.locator('.app').waitFor()
    const before = page.url()
    await page.getByRole('button', { name: '+ New page' }).last().click()
    await page.waitForFunction((href) => window.location.href !== href, before)
    await page.locator('.doc-editor').click()
    await pasteHtml(page, HTML)
    await page.waitForFunction(() => {
      const text = document.querySelector('.doc-editor')?.textContent ?? ''
      return text.includes('Ship on') && text.includes('please')
    })
    const result = await page.evaluate(() => {
      const root = document.querySelector('.doc-editor')
      const text = (root?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const chips = [...(root?.querySelectorAll('.date-chip') ?? [])].map(
        (chip) => ({
          date: chip.getAttribute('data-date') ?? '',
          label: (chip.textContent ?? '').replace(/\s+/g, ' ').trim(),
        }),
      )
      return { text, chips }
    })
    const timestampText = result.text.includes('Mar 4, 9am')
    const wordText = result.text.includes('this Friday')
    const invalidDayText = result.text.includes('Feb 31')
    const validChip = result.chips.some(
      (chip) => chip.date === '2026-01-15' && chip.label === 'Jan 15, 2026',
    )
    const blankChip = result.chips.some((chip) => chip.label === '')
    console.log(`editor_text=${JSON.stringify(result.text)}`)
    console.log(`chips=${JSON.stringify(result.chips)}`)
    console.log(`timestamp_text=${timestampText}`)
    console.log(`word_text=${wordText}`)
    console.log(`invalid_day_text=${invalidDayText}`)
    console.log(`valid_chip=${validChip}`)
    console.log(`blank_chip=${blankChip}`)
    if (
      !timestampText ||
      !wordText ||
      !invalidDayText ||
      !validChip ||
      blankChip ||
      result.text.includes('plain fallback')
    ) {
      throw new Error('non-ISO data-date paste dropped its text')
    }
  } finally {
    await browser.close()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'date paste failed'
  console.error(message)
  process.exit(1)
})
