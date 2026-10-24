import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/clipboard')

function read(name: string) {
  return readFileSync(join(dir, name), 'utf8')
}

export function sheetsClipboard() {
  const html = read('google-sheets.html')
  const plain = read('google-sheets.txt')
  if (
    !html.includes('<google-sheets-html-origin') ||
    !html.includes('data-sheets-value') ||
    !html.includes('content="Sheets"')
  ) {
    throw new Error('sheets fixture is not Google Sheets clipboard HTML')
  }
  return { html, plain, path: 'tests/fixtures/clipboard/google-sheets.html' }
}

export function excelClipboard() {
  const html = read('excel.html')
  const plain = read('excel.txt')
  if (
    !html.includes('content=Excel.Sheet') ||
    !html.includes('urn:schemas-microsoft-com:office:excel') ||
    !html.includes('mso-number-format')
  ) {
    throw new Error('excel fixture is not Excel clipboard HTML')
  }
  if (!plain.includes('\r\n')) throw new Error('excel plain fixture is not CRLF')
  return { html, plain, path: 'tests/fixtures/clipboard/excel.html' }
}
