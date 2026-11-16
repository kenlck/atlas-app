import { execFileSync, spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { stopChild } from './stop-child.ts'
import {
  assertLocalDatabaseUrl,
  clickNewDoc,
  submitAuthForm,
} from './verify-local.ts'

const PIN = '9b8669b2e0263cdc113aed62683f9308b1e8ff7e'
const TOO_BIG =
  'This page is too big to save (over 1 MB). Move some content to a sub-page.'
const MUTED = new Set(['rgb(120, 113, 108)', 'rgba(120, 113, 108, 1)'])
const repoRoot = join(import.meta.dirname, '..')
const arg = process.argv[2] ?? ''
const planted = arg.endsWith('-planted')
const id = planted ? arg.slice(0, -'-planted'.length) : arg
const side = planted ? 'planted' : 'head'

const secrets: string[] = []
const children: Array<ReturnType<typeof spawn>> = []
const temps: string[] = []
let pgName = ''
let pgEnv = ''
let stopping = false
let devLog = ''

function line(key: string, value: string | number | boolean) {
  console.log(`57_${id}_${side}_${key}=${value}`)
}

function remember(value: string) {
  if (value.length > 0) secrets.push(value)
}

function redact(text: string) {
  let out = text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function unusedPort() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await freePort()
    if (port !== 5432 && port !== 3000) return port
  }
  throw new Error('no free local port')
}

function runFile(cmd: string, args: string[], cwd = repoRoot) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code ?? 1}`))
    })
  })
}

async function ensureDatabase() {
  const inherited = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || ''
  if (inherited) {
    assertLocalDatabaseUrl(inherited)
    remember(inherited)
    process.env.DATABASE_URL = inherited
    delete process.env.TEST_DATABASE_URL
    return
  }
  const port = await unusedPort()
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('hex')
  remember(password)
  pgEnv = join(tmpdir(), `atlas-57-${process.pid}.env`)
  writeFileSync(
    pgEnv,
    `POSTGRES_USER=atlas\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=atlas\n`,
    { mode: 0o600 },
  )
  pgName = `atlas-57-pg-${process.pid}`
  await runFile('docker', [
    'run',
    '-d',
    '--name',
    pgName,
    '--env-file',
    pgEnv,
    '-p',
    `127.0.0.1:${port}:5432`,
    'postgres:16',
  ])
  rmSync(pgEnv, { force: true })
  pgEnv = ''
  const deadline = Date.now() + 60000
  let ready = false
  while (Date.now() < deadline) {
    ready = await runFile('docker', [
      'exec',
      pgName,
      'pg_isready',
      '-q',
      '-h',
      '127.0.0.1',
      '-U',
      'atlas',
    ]).then(
      () => true,
      () => false,
    )
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('local database did not start')
  const url = `postgresql://atlas:${password}@127.0.0.1:${port}/atlas`
  assertLocalDatabaseUrl(url)
  remember(url)
  process.env.DATABASE_URL = url
}

function ensureAuth(base: string) {
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    process.env.BETTER_AUTH_SECRET = 'issue57-fail-secret-not-a-credential'
  }
  remember(process.env.BETTER_AUTH_SECRET)
  if (!process.env.ADMIN_API_SECRET || process.env.ADMIN_API_SECRET.length < 32) {
    process.env.ADMIN_API_SECRET = 'issue57-fail-admin-not-a-credential'
  }
  remember(process.env.ADMIN_API_SECRET)
  process.env.BETTER_AUTH_URL = base
  process.env.BETTER_AUTH_TELEMETRY = '0'
}

function materialize(sha: string) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-57-'))
  temps.push(dir)
  const git = spawn('git', ['archive', '--format=tar', sha], { cwd: repoRoot })
  const tar = spawn('tar', ['-x', '-C', dir])
  git.stdout.pipe(tar.stdin)
  return new Promise<string>((resolve, reject) => {
    let failed = false
    let gitCode = -1
    let tarCode = -1
    const fail = () => {
      if (failed) return
      failed = true
      reject(new Error('pin extract failed'))
    }
    const done = () => {
      if (failed || gitCode < 0 || tarCode < 0) return
      if (gitCode !== 0 || tarCode !== 0) {
        fail()
        return
      }
      try {
        symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'))
        renameSync(join(dir, 'vite.config.ts'), join(dir, 'vite.config.app.ts'))
        writeFileSync(
          join(dir, 'vite.config.ts'),
          `import { defineConfig, mergeConfig } from 'vite'\nimport config from './vite.config.app.ts'\nexport default mergeConfig(config, defineConfig({ server: { fs: { allow: [${JSON.stringify(repoRoot)}, ${JSON.stringify(dir)}] } } }))\n`,
        )
        resolve(dir)
      } catch (error) {
        failed = true
        reject(error instanceof Error ? error : new Error('pin extract failed'))
      }
    }
    git.on('error', fail)
    tar.on('error', fail)
    git.on('close', (code) => {
      gitCode = code ?? 1
      done()
    })
    tar.on('close', (code) => {
      tarCode = code ?? 1
      done()
    })
  })
}

async function bootDev(root: string) {
  const port = await unusedPort()
  const base = `http://127.0.0.1:${port}`
  ensureAuth(base)
  devLog = join(tmpdir(), `atlas-57-dev-${process.pid}.log`)
  const logFd = openSync(devLog, 'a')
  const child = spawn(
    'pnpm',
    ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BETTER_AUTH_URL: base },
      stdio: ['ignore', logFd, logFd],
    },
  )
  children.push(child)
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(redact(readFileSync(devLog, 'utf8').slice(-1500) || 'dev server exited'))
    }
    try {
      const response = await fetch(`${base}/sign-in`)
      if (response.status === 200) {
        await response.text().catch(() => '')
        return base
      }
      await response.text().catch(() => '')
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(redact(readFileSync(devLog, 'utf8').slice(-1500) || 'dev server did not start'))
}

async function signUp(page: Page, base: string) {
  const password = 'issue57-fail-password'
  remember(password)
  const email = `size.${crypto.randomUUID()}@example.com`
  await page.goto(`${base}/sign-up`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const field = document.querySelector('#name')
    if (!field) return false
    return Object.getOwnPropertyNames(field).some((key) => key.startsWith('__reactProps'))
  })
  await page.locator('#name').fill('Size Limits')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.locator('.app').waitFor()
}

async function newDoc(page: Page) {
  const before = page.url()
  await clickNewDoc(page)
  await page.waitForFunction((href) => window.location.href !== href, before)
  await page.locator('#page-title').waitFor()
  await page.locator('.doc-editor').waitFor()
}

async function shot(page: Page, name: string) {
  if (planted) return
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  await page.screenshot({
    path: `/opt/cursor/artifacts/${name}`,
    animations: 'disabled',
    caret: 'hide',
  })
}

function pageIdOf(page: Page) {
  return page.url().match(/\/p\/([^/?#]+)/)?.[1] ?? ''
}

async function fc1(page: Page) {
  await page.route(
    (url) => url.pathname.includes('_serverFn') || url.pathname.includes('serverFn'),
    async (route) => {
      const request = route.request()
      const body = request.postData() ?? ''
      if (request.method() === 'POST' && body.includes('"pageId"') && body.includes('"body"')) {
        await route.fulfill({
          status: 413,
          contentType: 'text/plain',
          body: 'Payload too large',
        })
        return
      }
      await route.continue()
    },
  )
  const typed = `kept-${crypto.randomUUID().slice(0, 8)}`
  await page.locator('.doc-editor').click()
  await page.keyboard.type(typed)
  await page.locator('.retry').waitFor({ timeout: 20_000 })
  const banner = (await page.locator('.retry').innerText()).replace(/\s+/g, ' ').trim()
  const exact = banner === TOO_BIG
  const retry = (await page.locator('.retry').getByRole('button', { name: 'Retry' }).count()) > 0
  const text = (await page.locator('.doc-editor').innerText()).includes(typed)
  const draft = await page.evaluate((pageId) => {
    return sessionStorage.getItem(`atlas-draft:${pageId}`)
  }, pageIdOf(page))
  const kept = Boolean(draft && draft.includes(typed))
  const statusLoc = page.locator('.editing-chip .save')
  const status =
    (await statusLoc.count()) > 0 ? (await statusLoc.first().innerText()).trim() : ''
  line('exact', exact)
  line('retry', retry)
  line('text', text)
  line('draft', kept)
  line('status', status === 'Not saved')
  if (exact && !retry && text && kept && status === 'Not saved') {
    await shot(page, '57-fc1-too-big-banner.png')
  }
  return exact && !retry && text && kept && status === 'Not saved'
}

function watchSaves(page: Page) {
  const statuses: number[] = []
  page.on('response', (response) => {
    const request = response.request()
    if (request.method() !== 'POST') return
    const url = request.url()
    if (
      !url.includes('_serverFn') &&
      !url.includes('serverFn') &&
      !url.includes('/api/pages/save')
    ) {
      return
    }
    const body = request.postData() ?? ''
    if (!body.includes('"pageId"') || !body.includes('"title"')) return
    statuses.push(response.status())
  })
  return statuses
}

async function readCounter(page: Page) {
  const loc = page.locator('.title-count')
  if ((await loc.count()) === 0) {
    return { present: false, text: '', color: '', size: '', right: false }
  }
  const text = (await loc.innerText()).replace(/\s+/g, '')
  const style = await loc.evaluate((el) => {
    const computed = getComputedStyle(el)
    return { color: computed.color, size: computed.fontSize }
  })
  const box = await loc.boundingBox()
  const input = await page.locator('#page-title').boundingBox()
  const right = Boolean(
    box &&
      input &&
      box.x > input.x + input.width / 2 &&
      Math.abs(box.x + box.width - (input.x + input.width)) <= 3,
  )
  return { present: true, text, color: style.color, size: style.size, right }
}

async function pasteTitle(page: Page, text: string) {
  const input = page.locator('#page-title')
  await input.click()
  await page.keyboard.press('Control+A')
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value)
  }, text)
  await page.keyboard.press('Control+V')
  await page.waitForTimeout(250)
  const current = await input.inputValue()
  if (current.startsWith(text.slice(0, 1)) && (current.length === 200 || current.length === text.length)) {
    return
  }
  await input.evaluate((el, value) => {
    const target = el as HTMLInputElement
    target.focus()
    target.setSelectionRange(0, target.value.length)
    const data = new DataTransfer()
    data.setData('text/plain', value)
    target.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    )
  }, text)
  await page.waitForTimeout(250)
}

async function fc2(page: Page) {
  const statuses = watchSaves(page)
  const input = page.locator('#page-title')
  await input.fill('a'.repeat(179))
  await page.waitForFunction(
    () => (document.getElementById('page-title') as HTMLInputElement | null)?.value.length === 179,
  )
  const at179 = await readCounter(page)
  await input.press('b')
  await page.waitForFunction(() => {
    const field = document.getElementById('page-title') as HTMLInputElement | null
    return field?.value.length === 180 && field.value.endsWith('b')
  })
  const at180 = await readCounter(page)
  const twoHundred = 'c'.repeat(200)
  await input.fill(twoHundred)
  await input.press('Z')
  await page.waitForTimeout(200)
  const typed = await input.inputValue()
  const pasted = `P${'d'.repeat(249)}`
  await pasteTitle(page, pasted)
  const afterPaste = await input.inputValue()
  const counter = await readCounter(page)
  await page.waitForTimeout(6000)
  const saw400 = statuses.includes(400)
  line('absent_179', !at179.present)
  line('at_180', at180.present ? at180.text : false)
  line('typed_len', typed.length)
  line('paste_len', afterPaste.length)
  line('paste_cut', afterPaste === pasted.slice(0, 200))
  line('counter', counter.present ? counter.text : false)
  line('muted', MUTED.has(counter.color))
  line('size', counter.size || 'none')
  line('right', counter.right)
  line('saw_400', saw400)
  line('saves', statuses.join(',') || 'none')
  const passed =
    !at179.present &&
    at180.text === '180/200' &&
    MUTED.has(at180.color) &&
    at180.size === '12px' &&
    at180.right &&
    typed.length === 200 &&
    !typed.endsWith('Z') &&
    afterPaste.length === 200 &&
    afterPaste === pasted.slice(0, 200) &&
    counter.text === '200/200' &&
    MUTED.has(counter.color) &&
    counter.size === '12px' &&
    counter.right &&
    !saw400
  if (passed) await shot(page, '57-fc2-title-counter.png')
  return passed
}

async function cleanup() {
  if (stopping) return
  stopping = true
  for (const child of children) await stopChild(child).catch(() => undefined)
  if (pgName) await runFile('docker', ['rm', '-f', pgName]).catch(() => undefined)
  if (pgEnv) rmSync(pgEnv, { force: true })
  if (devLog) rmSync(devLog, { force: true })
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
}

const checks: Record<string, (page: Page) => Promise<boolean>> = { fc1, fc2 }

async function main() {
  const check = checks[id]
  if (!check) throw new Error('unknown step')
  const sha = planted
    ? PIN
    : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  line('sha', sha)
  await ensureDatabase()
  await runFile('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'])
  const root = planted ? await materialize(PIN) : repoRoot
  const base = await bootDev(root)
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    page.setDefaultNavigationTimeout(60_000)
    await signUp(page, base)
    await newDoc(page)
    const ok = await check(page)
    await browser.close()
    await cleanup()
    process.exit(ok ? 0 : 1)
  } catch (error) {
    await browser.close().catch(() => undefined)
    throw error
  }
}

main().catch(async (error: unknown) => {
  line('error', 1)
  console.error(redact(error instanceof Error ? error.message : 'failed'))
  await cleanup()
  process.exit(2)
})
