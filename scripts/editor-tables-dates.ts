import { chromium, type BrowserContext, type Page } from 'playwright'
import { sheetsHtml, sheetsPlain } from './table-date-states.ts'
import { assertLocalBaseUrl, submitAuthForm } from './verify-local.ts'

const BASE_URL = assertLocalBaseUrl(process.env.BASE_URL ?? 'http://127.0.0.1:3000')
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'tables-dates-password'

function excelHtml() {
  const rows = [
    ['E11', 'E12', 'E13', 'E14'],
    ['E21', 'E22', 'E23', 'E24'],
    ['E31', 'E32', 'E33', 'E34'],
    ['E41', 'E42', 'E43', 'E44'],
    ['E51', 'E52', 'E53', ''],
  ]
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td style="mso-number-format:General">${cell}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><!--StartFragment--><table><colgroup><col width="64" span="4"></colgroup><tbody>${body}</tbody></table><!--EndFragment--></body></html>`
}

async function pasteHtml(page: Page, html: string, plain: string) {
  await page.locator('.ProseMirror').evaluate((el, payload) => {
    const data = new DataTransfer()
    data.setData('text/html', payload.html)
    data.setData('text/plain', payload.plain)
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    el.dispatchEvent(event)
  }, { html, plain })
}

async function signUp(page: Page, name: string, email: string) {
  await page.goto(`${BASE_URL}/sign-up`, { waitUntil: 'networkidle' })
  await page.locator('#name').fill(name)
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.locator('.app').waitFor()
}

async function createPage(page: Page) {
  const previous = page.url()
  await page.getByRole('button', { name: '+ New page' }).last().click()
  await page.waitForFunction((href) => window.location.href !== href, previous)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').waitFor()
}

async function settleSave(page: Page) {
  const saving = page.getByText('Saving', { exact: true })
  if (!(await saving.isVisible().catch(() => false))) {
    await saving.waitFor({ timeout: 2500 }).catch(() => undefined)
  }
  await page.getByText('Saved', { exact: true }).waitFor()
}

async function fingerprint(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector('.doc-editor table')
    const rows = table
      ? [...table.querySelectorAll('tr')].map((row) =>
          [...row.children].map((cell) => ({
            tag: cell.tagName,
            colspan: cell.getAttribute('colspan') ?? '1',
            rowspan: cell.getAttribute('rowspan') ?? '1',
            width: (cell as HTMLElement).style.width || '',
          })),
        )
      : []
    const cols = table
      ? [...table.querySelectorAll('col')].map(
          (col) => (col as HTMLElement).style.width || (col as HTMLElement).style.minWidth,
        )
      : []
    const chip = document.querySelector('.date-chip')
    return {
      rows,
      cols,
      date: chip?.getAttribute('data-date') ?? '',
      label: (chip?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }
  })
}

async function contextPage(browser: Awaited<ReturnType<typeof chromium.launch>>, timezoneId: string) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    timezoneId,
  })
  const page = await context.newPage()
  await page.clock.install({ time: new Date('2026-03-01T02:00:00Z') })
  return { context, page }
}

async function reloadRecipe(page: Page) {
  await createPage(page)
  await page.locator('.doc-editor').click()
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.type(`Line ${index}`)
    await page.keyboard.press('Enter')
  }
  await page.keyboard.press('ControlOrMeta+Home')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.locator('.table-tools').waitFor()
  await page.getByText('Line 0', { exact: true }).click()
  await page.locator('.table-tools').waitFor({ state: 'hidden' })
  await page.locator('.doc').evaluate((el) => {
    el.scrollTop = 40
  })
  const before = await page.locator('.doc').evaluate((el) => ({
    height: el.clientHeight,
    scroll: el.scrollTop,
  }))
  await page.locator('.doc-editor td').first().click()
  await page.locator('.table-tools').waitFor()
  const after = await page.locator('.doc').evaluate((el) => ({
    height: el.clientHeight,
    scroll: el.scrollTop,
  }))
  const toolsHeight = await page.locator('.table-tools').evaluate((el) => el.getBoundingClientRect().height)
  console.log(`tools_row_height=${toolsHeight}`)
  console.log(`doc_height_before=${before.height}`)
  console.log(`doc_height_after=${after.height}`)
  console.log(`doc_scroll_before=${before.scroll}`)
  console.log(`doc_scroll_after=${after.scroll}`)
  console.log(`doc_shrunk_by_36=${before.height - after.height === 36}`)
  console.log(`doc_scroll_kept=${before.scroll === after.scroll}`)
  if (toolsHeight !== 36) throw new Error(`tools row height ${toolsHeight}`)
  if (before.height - after.height !== 36) throw new Error('doc area did not shrink by 36px')
  if (before.scroll !== after.scroll) throw new Error('tools row shifted the document scroll')

  await page.getByRole('button', { name: 'Row below' }).click()
  await page.getByRole('button', { name: 'Column right' }).click()
  const table = page.locator('.doc-editor table').first()
  await table.locator('tr').nth(2).locator('td, th').nth(2).click()
  await table.locator('tr').nth(3).locator('td, th').nth(3).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: 'Merge cells' }).click()
  await page.getByRole('button', { name: 'Header row' }).click()
  await page.getByRole('button', { name: 'Header row' }).click()
  const edge = table.locator('th, td').first()
  const box = await edge.boundingBox()
  if (!box) throw new Error('missing cell box')
  await page.mouse.move(box.x + box.width - 1, box.y + 12)
  await page.locator('.column-resize-handle').first().waitFor()
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 90, box.y + 12, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Date', exact: true }).click()
  await page.locator('.date-chip').click()
  await page.locator('.date-picker').waitFor()
  for (let index = 0; index < 24; index += 1) {
    const title = (await page.locator('.date-picker-title').innerText()).trim()
    if (title === 'January 2026') break
    const [month, yearText] = title.split(' ')
    const year = Number(yearText)
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
    const current = year * 12 + months.indexOf(month)
    const target = 2026 * 12
    await page.getByRole('button', { name: current > target ? 'Previous month' : 'Next month' }).click()
  }
  await page.locator('.date-picker [data-date="2026-01-15"]').click()
  await settleSave(page)
  const first = await fingerprint(page)
  console.log(`before_reload=${JSON.stringify(first)}`)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor table').first().waitFor()
  await page.locator('.date-chip').waitFor()
  const second = await fingerprint(page)
  console.log(`after_reload=${JSON.stringify(second)}`)
  const same = JSON.stringify(first) === JSON.stringify(second)
  console.log(`reload_exact_match=${same}`)
  console.log(`date_label=${second.label}`)
  console.log(`date_value=${second.date}`)
  if (!same) throw new Error('table or date changed across reload')
  if (second.date !== '2026-01-15' || second.label !== 'Jan 15, 2026') {
    throw new Error(`date chip is ${second.date} ${second.label}`)
  }
}

async function pageOverflow(page: Page, label: string) {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  console.log(
    `${label} document.documentElement.scrollWidth=${result.scrollWidth} innerWidth=${result.innerWidth} ok=${result.scrollWidth <= result.innerWidth}`,
  )
  if (result.scrollWidth > result.innerWidth) {
    throw new Error(`${label} page overflow`)
  }
}

async function overflowRecipe(page: Page) {
  await createPage(page)
  await page.locator('.doc-editor').click()
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole('button', { name: 'Column right' }).click()
  }
  const table = page.locator('.doc-editor table')
  const cols = await table.locator('tr').first().locator('td, th').count()
  console.log(`wide_columns=${cols}`)
  if (cols !== 8) throw new Error(`expected 8 columns, got ${cols}`)
  const edge = table.locator('th').first()
  const box = await edge.boundingBox()
  if (!box) throw new Error('missing header box')
  await page.mouse.move(box.x + box.width - 1, box.y + 12)
  await page.locator('.column-resize-handle').first().waitFor()
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 480, box.y + 12, { steps: 8 })
  await page.mouse.up()
  const read = async () =>
    page.locator('.tableWrapper').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }))
  const desktop = await read()
  console.log(`table_wrap_1280 scrollWidth=${desktop.scrollWidth} clientWidth=${desktop.clientWidth}`)
  if (desktop.scrollWidth <= desktop.clientWidth) throw new Error('table does not scroll at 1280')
  await pageOverflow(page, '1280-table-wide')
  await page.setViewportSize({ width: 390, height: 844 })
  const phone = await read()
  console.log(`table_wrap_390 scrollWidth=${phone.scrollWidth} clientWidth=${phone.clientWidth}`)
  if (phone.scrollWidth <= phone.clientWidth) throw new Error('table does not scroll at 390')
  await pageOverflow(page, '390-table-wide')
  const tools = await page.locator('.table-tools').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  console.log(`table_tools_390 scrollWidth=${tools.scrollWidth} clientWidth=${tools.clientWidth}`)
  if (tools.scrollWidth <= tools.clientWidth) throw new Error('table tools do not scroll at 390')
  const column = await page.locator('.col').evaluate((el) => el.getBoundingClientRect().width)
  console.log(`column_width_390=${column}`)
  if (column > 390) throw new Error('column is wider than the viewport')
}

async function readChip(page: Page, index: number) {
  const chip = page.locator('.date-chip').nth(index)
  await chip.waitFor()
  const date = await chip.getAttribute('data-date')
  const label = ((await chip.innerText()) ?? '').trim()
  return { date, label }
}

async function timezoneRecipe(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const first = await contextPage(browser, 'Pacific/Kiritimati')
  const stamp = Date.now()
  await signUp(first.page, 'Date East', `date.east.${stamp}@example.com`)
  await createPage(first.page)
  await first.page.locator('.doc-editor').click()
  await first.page.getByRole('button', { name: 'Date', exact: true }).click()
  await settleSave(first.page)
  const east = await readChip(first.page, 0)
  console.log(`kiritimati_date=${east.date}`)
  console.log(`kiritimati_label=${east.label}`)
  if (east.date !== '2026-03-01' || east.label !== 'Mar 1, 2026') {
    throw new Error(`insert used ${east.date} ${east.label}`)
  }
  const href = first.page.url()
  const storage = await first.context.storageState()
  const second = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    timezoneId: 'Pacific/Midway',
    storageState: storage,
  })
  const west = await second.newPage()
  await west.clock.install({ time: new Date('2026-03-01T02:00:00Z') })
  await west.goto(href, { waitUntil: 'networkidle' })
  const seen = await readChip(west, 0)
  console.log(`midway_seen_date=${seen.date}`)
  console.log(`midway_seen_label=${seen.label}`)
  console.log(`same_day=${seen.date === east.date && seen.label === east.label}`)
  if (seen.date !== east.date || seen.label !== east.label) {
    throw new Error('date chip changed across time zones')
  }
  const chipBox = await west.locator('.date-chip').boundingBox()
  if (!chipBox) throw new Error('missing date chip')
  await west.mouse.click(chipBox.x + chipBox.width + 24, chipBox.y + chipBox.height / 2)
  await west.keyboard.press('Enter')
  await west.getByRole('button', { name: 'Date', exact: true }).click()
  await settleSave(west)
  const local = await readChip(west, 1)
  console.log(`midway_inserted_date=${local.date}`)
  console.log(`midway_inserted_label=${local.label}`)
  if (local.date !== '2026-02-28' || local.label !== 'Feb 28, 2026') {
    throw new Error(`local insert was ${local.date} ${local.label}`)
  }
  await first.page.goto(href, { waitUntil: 'networkidle' })
  const back = await readChip(first.page, 1)
  console.log(`kiritimati_seen_date=${back.date}`)
  console.log(`kiritimati_seen_label=${back.label}`)
  console.log(`stored_day_stable=${back.date === '2026-02-28' && back.label === 'Feb 28, 2026'}`)
  if (back.date !== '2026-02-28' || back.label !== 'Feb 28, 2026') {
    throw new Error('stored local date changed for the other time zone')
  }
  await second.close()
  await first.context.close()
}

async function countTable(page: Page, index: number) {
  const table = page.locator('.doc-editor table').nth(index)
  await table.waitFor()
  const rows = await table.locator('tr').count()
  const cells = []
  for (let row = 0; row < rows; row += 1) {
    const values = await table.locator('tr').nth(row).locator('td, th').allTextContents()
    cells.push(values.map((value) => value.trim()))
  }
  return cells
}

async function pasteRecipe(page: Page) {
  await createPage(page)
  await page.locator('.doc-editor').click()
  await pasteHtml(page, sheetsHtml(), sheetsPlain())
  const sheets = await countTable(page, 0)
  console.log(`sheets_rows=${sheets.length}`)
  console.log(`sheets_cells=${JSON.stringify(sheets)}`)
  if (sheets.length !== 5 || sheets.some((row) => row.length !== 4)) {
    throw new Error('sheets paste lost rows or cells')
  }
  if (sheets[0][0] !== 'S11' || sheets[4][2] !== 'S53' || sheets[4][3] !== '') {
    throw new Error('sheets paste changed cell text')
  }
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await pasteHtml(
    page,
    excelHtml(),
    ['E11', 'E12', 'E13', 'E14'].join('\t'),
  )
  const excel = await countTable(page, 1)
  console.log(`excel_rows=${excel.length}`)
  console.log(`excel_cells=${JSON.stringify(excel)}`)
  if (excel.length !== 5 || excel.some((row) => row.length !== 4)) {
    throw new Error('excel paste lost rows or cells')
  }
  if (excel[0][0] !== 'E11' || excel[4][3] !== '') {
    throw new Error('excel paste changed cell text')
  }
  console.log('paste_rows_kept=true')
  console.log('paste_cells_kept=true')
}

async function main() {
  const recipe = process.argv[2]
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  let context: BrowserContext | null = null
  try {
    if (recipe === '3-3') {
      await timezoneRecipe(browser)
      return
    }
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const stamp = Date.now()
    await signUp(page, 'Table Writer', `tables.${recipe}.${stamp}@example.com`)
    if (recipe === '3-1') await reloadRecipe(page)
    else if (recipe === '3-2') await overflowRecipe(page)
    else if (recipe === '3-4') await pasteRecipe(page)
    else {
      console.error('usage: tsx scripts/editor-tables-dates.ts [3-1|3-2|3-3|3-4]')
      process.exit(2)
    }
  } finally {
    await context?.close()
    await browser.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'editor recipe failed')
  process.exit(1)
})
