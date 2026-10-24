import { chromium } from 'playwright'
import { assertLocalBaseUrl } from './verify-local.ts'

const BASE_URL = assertLocalBaseUrl(process.env.BASE_URL ?? '')
const NOTE =
  "Atlas doesn't send reset emails. Ask whoever runs your Atlas to reset it. They'll give you a temporary password, and you'll set a new one when you sign in."

async function main() {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  await page.goto(`${BASE_URL}/forgot-password`, { waitUntil: 'networkidle' })
  const note = (await page.locator('.note').innerText()).replace(/\s+/g, ' ').trim()
  const forms = await page.locator('form').count()
  const inputs = await page.locator('input').count()
  const emails = await page.locator('input[type="email"], input[name="email"]').count()
  console.log(`note_text=${note}`)
  console.log(`form_count=${forms}`)
  console.log(`input_count=${inputs}`)
  console.log(`email_field_count=${emails}`)
  console.log(
    `note_has_required_sentence=${note.includes('Ask whoever runs your Atlas to reset it.')}`,
  )
  await browser.close()
  if (note !== NOTE) throw new Error('forgot-password note text mismatch')
  if (forms !== 0 || inputs !== 0 || emails !== 0) {
    throw new Error('forgot-password has a form or input')
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'forgot-password failed')
  process.exit(1)
})
