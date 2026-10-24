import type { Page } from 'playwright'

const SHEETS_ROWS = [
  ['S11', 'S12', 'S13', 'S14'],
  ['S21', 'S22', 'S23', 'S24'],
  ['S31', 'S32', 'S33', 'S34'],
  ['S41', 'S42', 'S43', 'S44'],
  ['S51', 'S52', 'S53', ''],
]

export function sheetsHtml() {
  const rows = SHEETS_ROWS.map(
    (row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`,
  ).join('')
  return `<html><body><!--StartFragment--><google-sheets-html-origin><meta charset="utf-8"><table xmlns="http://www.w3.org/1999/xhtml"><tbody>${rows}</tbody></table><!--EndFragment--></body></html>`
}

export function sheetsPlain() {
  return SHEETS_ROWS.map((row) => row.join('\t')).join('\n')
}

async function frame(
  page: Page,
  name: string,
  shot: (name: string) => Promise<void>,
) {
  const width = name.startsWith('390-') ? 390 : 1280
  const height = width === 390 ? 844 : 800
  const size = page.viewportSize()
  if (!size || size.width !== width || size.height !== height) {
    await page.setViewportSize({ width, height })
  }
  await shot(name)
}

async function appendParagraph(page: Page) {
  await page.locator('.doc-editor').evaluate((el) => {
    const host = el.parentElement
    if (!host) throw new Error('editor host missing')
    const key = Object.keys(host).find((name) => name.startsWith('__reactFiber'))
    if (!key) throw new Error('editor fiber missing')
    let fiber = (host as unknown as Record<string, any>)[key]
    let editor = null
    while (fiber) {
      const props = fiber.memoizedProps
      if (props && props.editor && typeof props.editor.chain === 'function') {
        editor = props.editor
        break
      }
      fiber = fiber.return
    }
    if (!editor) throw new Error('editor missing')
    const end = editor.state.doc.content.size
    editor.chain().insertContentAt(end, { type: 'paragraph' }).focus('end').run()
  })
}

async function settleSave(page: Page) {
  const saving = page.getByText('Saving', { exact: true })
  if (!(await saving.isVisible().catch(() => false))) {
    await saving.waitFor({ timeout: 2500 }).catch(() => undefined)
  }
  await page.getByText('Saved', { exact: true }).waitFor()
}

async function pasteHtml(page: Page, html: string, plain: string) {
  await page.locator('.ProseMirror').evaluate((el, payload) => {
    const data = new DataTransfer()
    data.setData('text/html', payload.html)
    data.setData('text/plain', payload.plain)
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'clipboardData', { value: data })
    el.dispatchEvent(event)
  }, { html, plain })
}

async function hoverColumnEdge(page: Page, cell: ReturnType<Page['locator']>) {
  const box = await cell.boundingBox()
  if (!box) throw new Error('column edge has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + 16)
  await page.mouse.move(box.x + box.width - 1, box.y + 16)
  await page.locator('.column-resize-handle').first().waitFor()
  return box
}

async function widenColumn(page: Page, cell: ReturnType<Page['locator']>, extra: number) {
  const box = await hoverColumnEdge(page, cell)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + extra, box.y + 16, { steps: 8 })
  await page.mouse.up()
  await page.mouse.move(20, 20)
}

export async function captureTableDateStates(
  page: Page,
  shot: (name: string) => Promise<void>,
) {
  await page.locator('.doc-editor').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('Notes')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.locator('.doc-editor table').first().waitFor()
  await page.locator('.table-tools').waitFor()
  await page.getByText('Notes', { exact: true }).click()
  await page.locator('.table-tools').waitFor({ state: 'hidden' })
  await frame(page, '1280-table-default', shot)

  await page.locator('.doc-editor tbody tr').nth(1).locator('td, th').first().click()
  await page.locator('.table-tools').waitFor()
  const merge = page.getByRole('button', { name: 'Merge cells' })
  if (await merge.isEnabled()) throw new Error('Merge cells is enabled with one cell')
  await frame(page, '1280-table-tools', shot)

  const table = page.locator('.doc-editor table').first()
  await widenColumn(page, table.locator('th').first(), 70)
  await table.locator('tbody tr').nth(1).locator('td, th').nth(2).click()
  await table.locator('tbody tr').nth(2).locator('td, th').nth(2).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: 'Merge cells' }).click()
  await table.locator('[rowspan="2"]').waitFor()
  await table.locator('tbody tr').nth(1).locator('td, th').nth(0).click()
  await table.locator('tbody tr').nth(2).locator('td, th').nth(1).click({ modifiers: ['Shift'] })
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'Merge cells',
    )
    return Boolean(button && !button.disabled)
  })
  await frame(page, '1280-table-selection', shot)

  await hoverColumnEdge(page, table.locator('th').first())
  await frame(page, '1280-table-resize', shot)
  await page.mouse.move(20, 20)

  await appendParagraph(page)
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press('Enter')
  }
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole('button', { name: 'Column right' }).click()
  }
  const wide = page.locator('.doc-editor table').nth(1)
  await wide.locator('tr').first().waitFor()
  const wideCols = await wide.locator('tr').first().locator('td, th').count()
  if (wideCols !== 8) throw new Error(`wide table has ${wideCols} columns`)
  const wideHeader = wide.locator('th').first()
  await wideHeader.scrollIntoViewIfNeeded()
  await widenColumn(page, wideHeader, 420)
  const wideWrap = page.locator('.doc-editor .tableWrapper').nth(1)
  await wide.scrollIntoViewIfNeeded()
  const wideScroll = await wideWrap.evaluate((el) => {
    el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2)
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
    }
  })
  console.log(`table_wide_1280 ${JSON.stringify(wideScroll)}`)
  if (wideScroll.scrollWidth <= wideScroll.clientWidth) {
    throw new Error('wide table does not scroll inside the column at 1280')
  }
  await logPageOverflow(page, '1280-table-wide')
  await frame(page, '1280-table-wide', shot)

  await appendParagraph(page)
  await page.keyboard.type('Pasted')
  await page.keyboard.press('Enter')
  await pasteHtml(page, sheetsHtml(), sheetsPlain())
  const pasted = page.locator('.doc-editor table').nth(2)
  await pasted.waitFor()
  const pastedRows = await pasted.locator('tr').count()
  const pastedCells = await pasted.locator('tr').first().locator('td, th').count()
  console.log(`table_paste rows=${pastedRows} cells=${pastedCells}`)
  if (pastedRows !== 5 || pastedCells !== 4) {
    throw new Error(`pasted table is ${pastedRows}x${pastedCells}`)
  }
  await pasted.scrollIntoViewIfNeeded()
  await frame(page, '1280-table-paste', shot)

  await appendParagraph(page)
  await page.keyboard.type('Meet ')
  await page.getByRole('button', { name: 'Date', exact: true }).click()
  await page.locator('.date-chip').waitFor()
  await page.keyboard.type(' here')
  await page.locator('.doc').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.locator('.date-chip').scrollIntoViewIfNeeded()
  await frame(page, '1280-date-chip', shot)

  await page.locator('.date-chip').evaluate((el) => {
    if (el instanceof HTMLElement) el.focus({ focusVisible: true })
  })
  await frame(page, '1280-date-chip-focus', shot)

  const today = (await page.locator('.date-chip').getAttribute('data-date')) ?? ''
  await page.locator('.date-chip').click()
  await page.locator('.date-picker').waitFor()
  const other = today.replace(/-(\d{2})$/, '-20')
  await page.locator(`.date-picker [data-date="${other}"]`).click()
  await page.locator('.date-picker').waitFor({ state: 'hidden' })
  await page.locator('.date-chip').click()
  await page.locator('.date-picker').waitFor()
  await page.locator('.date-picker .today').waitFor()
  await page.locator('.date-picker .selected').waitFor()
  await frame(page, '1280-date-picker', shot)

  await page.keyboard.press('Escape')
  await page.locator('.date-picker').waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.date-chip').scrollIntoViewIfNeeded()
  await page.getByText('Meet', { exact: false }).click()
  await page.keyboard.press('Home')
  const startTop = (await page.locator('.date-chip').boundingBox())?.y ?? 0
  for (let index = 0; index < 40; index += 1) {
    const box = await page.locator('.date-chip').boundingBox()
    if (!box) break
    if (box.y > startTop + 4) {
      await page.keyboard.press('Backspace')
      break
    }
    if (box.x + box.width > 300) break
    await page.keyboard.type('m')
  }
  await page.locator('.date-chip').click()
  await page.locator('.date-picker').waitFor()
  const pickerBox = await page.locator('.date-picker').boundingBox()
  console.log(`date_picker_390 ${JSON.stringify(pickerBox)}`)
  if (!pickerBox) throw new Error('date picker missing at 390')
  if (pickerBox.x < 15 || pickerBox.x + pickerBox.width > 390 - 15) {
    throw new Error('date picker is not kept 16px from the viewport edges')
  }
  await frame(page, '390-date-picker', shot)
  await page.keyboard.press('Escape')

  await wide.scrollIntoViewIfNeeded()
  const phoneScroll = await wideWrap.evaluate((el) => {
    el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2)
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
    }
  })
  console.log(`table_wide_390 ${JSON.stringify(phoneScroll)}`)
  if (phoneScroll.scrollWidth <= phoneScroll.clientWidth) {
    throw new Error('wide table does not scroll inside the column at 390')
  }
  await logPageOverflow(page, '390-table-wide')
  await frame(page, '390-table-wide', shot)

  await settleSave(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor table').first().waitFor()
  await page.locator('.doc').evaluate((el) => {
    el.scrollTop = 0
  })
  const reloaded = page.locator('.doc-editor table').first()
  await reloaded.locator('[rowspan="2"]').waitFor()
  await reloaded.locator('tbody tr').nth(1).locator('td, th').nth(0).click()
  await reloaded.locator('tbody tr').nth(2).locator('td, th').nth(1).click({ modifiers: ['Shift'] })
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'Merge cells',
    )
    return Boolean(button && !button.disabled)
  })
  await frame(page, '1280-table-reload', shot)
  await page.setViewportSize({ width: 1280, height: 800 })
}

async function logPageOverflow(page: Page, label: string) {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  console.log(
    `${label} document.documentElement.scrollWidth=${result.scrollWidth} innerWidth=${result.innerWidth} ok=${result.scrollWidth <= result.innerWidth}`,
  )
  if (result.scrollWidth > result.innerWidth) {
    throw new Error(`${label} page overflow ${result.scrollWidth} > ${result.innerWidth}`)
  }
}
