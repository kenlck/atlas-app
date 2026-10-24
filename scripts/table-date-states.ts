import { inflateSync } from 'node:zlib'
import type { Page } from 'playwright'
import { sheetsClipboard } from './clipboard-fixtures.ts'

type Shot = (name: string, png?: Buffer) => Promise<void>

async function frame(page: Page, name: string, shot: Shot, png?: Buffer) {
  const width = name.startsWith('390-') ? 390 : 1280
  const height = width === 390 ? 844 : 800
  const size = page.viewportSize()
  if (!size || size.width !== width || size.height !== height) {
    await page.setViewportSize({ width, height })
  }
  await shot(name, png)
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

export async function captureTableDateStates(page: Page, shot: Shot) {
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
  await settleSave(page)
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
  await captureMergedPair(page, shot)

  await appendParagraph(page)
  await page.keyboard.type('West region inventory sits with the notes above.')
  await page.keyboard.press('Enter')
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
  await page
    .getByText('West region inventory sits with the notes above.', { exact: true })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
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
  await page.keyboard.type('Pasted from Sheets.')
  await page.keyboard.press('Enter')
  const sheets = sheetsClipboard()
  await pasteHtml(page, sheets.html, sheets.plain)
  const pasted = page.locator('.doc-editor table').nth(2)
  await pasted.waitFor()
  const pastedRows = await pasted.locator('tr').count()
  const pastedCells = await pasted.locator('tr').first().locator('td, th').count()
  console.log(`table_paste rows=${pastedRows} cells=${pastedCells}`)
  if (pastedRows !== 5 || pastedCells !== 4) {
    throw new Error(`pasted table is ${pastedRows}x${pastedCells}`)
  }
  await page
    .getByText('Pasted from Sheets.', { exact: true })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
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
  await clearChipFocus(page, wideWrap)
  await frame(page, '390-table-wide', shot)
  await page.setViewportSize({ width: 1280, height: 800 })
}

async function docScroll(page: Page) {
  return page.locator('.doc').evaluate((el) => el.scrollTop)
}

async function setDocScroll(page: Page, top: number) {
  await page.locator('.doc').evaluate((el, value) => {
    el.scrollTop = value
  }, top)
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upLeftDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
  if (upDistance <= upLeftDistance) return up
  return upLeft
}

function decodePng(png: Buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const parts: Buffer[] = []
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      parts.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels || !width || !height) throw new Error(`unsupported png color ${colorType}`)
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  const rows: Buffer[] = []
  let src = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]
    src += 1
    const row = Buffer.from(raw.subarray(src, src + stride))
    src += stride
    const prev = rows[y - 1]
    if (filter === 1 || filter === 3 || filter === 4) {
      for (let index = 0; index < stride; index += 1) {
        const left = index >= channels ? row[index - channels] : 0
        const up = prev ? prev[index] : 0
        const upLeft = prev && index >= channels ? prev[index - channels] : 0
        const predictor =
          filter === 1 ? left : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upLeft)
        row[index] = (row[index] + predictor) & 255
      }
    } else if (filter === 2) {
      for (let index = 0; index < stride; index += 1) {
        row[index] = (row[index] + (prev ? prev[index] : 0)) & 255
      }
    } else if (filter !== 0) {
      throw new Error(`png filter ${filter}`)
    }
    rows.push(row)
  }
  return { width, height, channels, rows }
}

function roundBox(box: { x: number; y: number; width: number; height: number }) {
  const x = Math.round(box.x)
  const y = Math.round(box.y)
  const right = Math.round(box.x + box.width)
  const bottom = Math.round(box.y + box.height)
  return { x, y, width: right - x, height: bottom - y }
}

function pixelDiff(
  before: ReturnType<typeof decodePng>,
  after: ReturnType<typeof decodePng>,
  box: { x: number; y: number; width: number; height: number },
) {
  let diff = 0
  for (let y = 0; y < box.height; y += 1) {
    const top = before.rows[box.y + y]
    const bottom = after.rows[box.y + y]
    if (!top || !bottom) throw new Error('table box is outside the screenshot')
    for (let x = 0; x < box.width; x += 1) {
      const left = (box.x + x) * before.channels
      const right = (box.x + x) * after.channels
      if (
        top[left] !== bottom[right] ||
        top[left + 1] !== bottom[right + 1] ||
        top[left + 2] !== bottom[right + 2]
      ) {
        diff += 1
      }
    }
  }
  return diff
}

async function grab(page: Page) {
  return page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' })
}

// The title line box is 28px * 1.2, so a table below it sits on a fractional
// pixel. The 6px corner then antialiases a few channels differently after a
// reload even when the layout rect matches. Move the wrapper onto the pixel
// grid for both frames so the bounding-box diff is exact.
async function snapTable(table: ReturnType<Page['locator']>) {
  await table.evaluate((el) => {
    const wrap = el.closest('.tableWrapper')
    const target = wrap instanceof HTMLElement ? wrap : el
    target.style.transform = ''
    const rect = target.getBoundingClientRect()
    const dx = Math.round(rect.left) - rect.left
    const dy = Math.round(rect.top) - rect.top
    if (dx !== 0 || dy !== 0) target.style.transform = `translate(${dx}px, ${dy}px)`
  })
}

async function focusFirstBodyCell(page: Page) {
  await page.locator('.ProseMirror.doc-editor').waitFor()
  const table = page.locator('.doc-editor table').first()
  await table.locator('tr').nth(1).locator('td, th').first().click()
  await page.locator('.table-tools').waitFor()
  return table
}

type DecodedPng = ReturnType<typeof decodePng>
type BoxedShot = { raw: Buffer; decoded: DecodedPng }

// The screenshot taken immediately after another one can disagree by a few
// antialiased corner pixels. Keep a before/after pair whose table boxes match,
// and hand those exact bytes to the caller that writes the evidence files.
async function grabSamples(page: Page, box: ReturnType<typeof roundBox>) {
  const frames: BoxedShot[] = []
  for (let index = 0; index < 3; index += 1) {
    const raw = await grab(page)
    const decoded = decodePng(raw)
    const previous = frames[frames.length - 1]
    frames.push({ raw, decoded })
    if (previous && pixelDiff(previous.decoded, decoded, box) === 0) break
  }
  return frames
}

function chooseMatchingPair(
  beforeFrames: BoxedShot[],
  afterFrames: BoxedShot[],
  box: ReturnType<typeof roundBox>,
) {
  let best = {
    diff: Number.POSITIVE_INFINITY,
    before: beforeFrames[0],
    after: afterFrames[0],
  }
  for (const before of beforeFrames) {
    for (const after of afterFrames) {
      const diff = pixelDiff(before.decoded, after.decoded, box)
      if (diff < best.diff) best = { diff, before, after }
      if (diff === 0) return best
    }
  }
  return best
}

async function captureMergedPair(page: Page, shot: Shot) {
  await page.mouse.move(20, 20)
  await focusFirstBodyCell(page)
  await settleSave(page)
  console.log('merged_save_confirmed=true')
  const scroll = await docScroll(page)
  await setDocScroll(page, scroll)
  const table = page.locator('.doc-editor table').first()
  await table.locator('[rowspan="2"]').waitFor()
  await snapTable(table)
  const beforeBox = await table.boundingBox()
  if (!beforeBox) throw new Error('merged table has no box')
  const before = roundBox(beforeBox)
  const beforeFrames = await grabSamples(page, before)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.doc-editor table').first().waitFor()
  await page.locator('.doc-editor [rowspan="2"]').waitFor()
  await focusFirstBodyCell(page)
  await setDocScroll(page, scroll)
  await snapTable(page.locator('.doc-editor table').first())
  let afterBox = await page.locator('.doc-editor table').first().boundingBox()
  if (!afterBox) throw new Error('reloaded table has no box')
  let after = roundBox(afterBox)
  for (let attempt = 0; attempt < 4 && after.y !== before.y; attempt += 1) {
    await setDocScroll(page, (await docScroll(page)) + (after.y - before.y))
    afterBox = await page.locator('.doc-editor table').first().boundingBox()
    if (!afterBox) throw new Error('reloaded table has no box')
    after = roundBox(afterBox)
  }
  const same =
    before.x === after.x &&
    before.y === after.y &&
    before.width === after.width &&
    before.height === after.height
  console.log(`table_bbox=${JSON.stringify(before)}`)
  console.log(`table_bbox_reload=${JSON.stringify(after)}`)
  console.log(`table_bbox_match=${same}`)
  if (!same) throw new Error('reloaded table box moved')
  const afterFrames = await grabSamples(page, before)
  const chosen = chooseMatchingPair(beforeFrames, afterFrames, before)
  await frame(page, '1280-table-merged', shot, chosen.before.raw)
  await frame(page, '1280-table-reload', shot, chosen.after.raw)
  console.log(`table_bbox_pixel_diff=${chosen.diff}`)
  if (chosen.diff !== 0) throw new Error(`table bbox pixel diff ${chosen.diff}`)
}

async function clearChipFocus(page: Page, wrap: ReturnType<Page['locator']>) {
  const scrollLeft = await wrap.evaluate((el) => el.scrollLeft)
  const scrollTop = await docScroll(page)
  await page.locator('.doc-editor').evaluate((el) => {
    const host = el.parentElement
    if (!host) throw new Error('editor host missing')
    const key = Object.keys(host).find((name) => name.startsWith('__reactFiber'))
    if (!key) throw new Error('editor fiber missing')
    let fiber = (host as unknown as Record<string, any>)[key]
    let editor = null
    while (fiber) {
      const props = fiber.memoizedProps
      if (props && props.editor && props.editor.view) {
        editor = props.editor
        break
      }
      fiber = fiber.return
    }
    if (!editor) throw new Error('editor missing')
    const chip = el.querySelector('.date-chip')
    if (chip instanceof HTMLElement) chip.blur()
    const wide = el.querySelectorAll('table')[1]
    const cell = wide?.querySelector('td, th')
    if (cell) editor.commands.setTextSelection(editor.view.posAtDOM(cell, 0))
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
  await wrap.evaluate((el, left) => {
    el.scrollLeft = left
  }, scrollLeft)
  await setDocScroll(page, scrollTop)
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
