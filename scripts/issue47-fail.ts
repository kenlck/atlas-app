import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import {
  assertLocalBaseUrl,
  assertLocalDatabaseUrl,
  enterEdit,
  submitAuthForm,
} from './verify-local.ts'

const PIN = '881e9a8a7bda92cbd5783e63b4c28b38cab835ee'
const PHONE = { width: 390, height: 844 }
const DESK = { width: 1280, height: 800 }
const TITLE = 'Sarah phone width notes'
const repoRoot = join(import.meta.dirname, '..')
const artifacts = process.env.ARTIFACTS_DIR || '/opt/cursor/artifacts'

const hidden: string[] = []

function line(name: string, value: string | number | boolean) {
  console.log(`${name}=${value}`)
}

function redact(text: string) {
  let out = text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
  for (const secret of hidden) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]')
  }
  return out
}

function remember(secret: string) {
  if (secret) hidden.push(secret)
}

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>

type Person = {
  user: { id: string; email: string; name: string }
  password: string
}

type App = {
  createPage: (
    userId: string,
    input: { spaceId: string; title?: string },
  ) => Promise<{ id: string }>
  savePage: (
    userId: string,
    input: {
      pageId: string
      title: string
      body: Json
      updatedAt?: string | null
    },
  ) => Promise<{ updatedAt: string }>
  getPageView: (
    userId: string,
    pageId: string,
  ) => Promise<{ updatedAt: string; title: string }>
  createUser: (name?: string) => Promise<Person>
  createTeam: (
    userId: string,
    name: string,
  ) => Promise<{ id: string; spaceId: string }>
  createInvite: (
    actorId: string,
    teamId: string,
    inviteeUserId: string,
  ) => Promise<{ id: string }>
  acceptInvite: (userId: string, inviteId: string) => Promise<unknown>
  getSql: () => Sql
  closeDb: () => Promise<void>
}

type Json = { type: string; content?: Json[] } & Record<string, unknown>

type Box = { x: number; y: number; w: number; h: number }

type Ctx = {
  base: string
  planted: boolean
  app: App
  browser: Browser
  spaceId: string
  ownerPage: string
  memberPage: string
  owner: Person
  member: Person
  other: Person
}

function doc(text: string): Json {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function runFile(cmd: string, args: string[], env = process.env) {
  return new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(redact(`${stderr || error.message}`.slice(0, 500))))
        return
      }
      resolve(String(stdout))
    })
  })
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

type Child = ReturnType<typeof spawn>

const children: Child[] = []
let pgName = ''
let pgEnv = ''
let stopping = false

async function stopChild(child: Child) {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function cleanup() {
  if (stopping) return
  stopping = true
  for (const child of children) await stopChild(child)
  if (pgName)
    await runFile('docker', ['rm', '-f', pgName]).catch(() => undefined)
  if (pgEnv) rmSync(pgEnv, { force: true })
}

async function shutdown(code: number): Promise<never> {
  await cleanup()
  process.exit(code)
}

process.on('SIGTERM', () => {
  void shutdown(143)
})
process.on('SIGINT', () => {
  void shutdown(130)
})

async function ensureDatabase() {
  const inherited =
    process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || ''
  if (inherited) {
    assertLocalDatabaseUrl(inherited)
    remember(inherited)
    process.env.DATABASE_URL = inherited
    line('47_db', 'local')
    return
  }
  const port = await freePort()
  if (port === 5432) throw new Error('refusing database port 5432')
  const password = Buffer.from(
    crypto.getRandomValues(new Uint8Array(18)),
  ).toString('hex')
  remember(password)
  pgEnv = join(tmpdir(), `atlas-47-${process.pid}.env`)
  writeFileSync(
    pgEnv,
    `POSTGRES_USER=atlas\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=atlas\n`,
    {
      mode: 0o600,
    },
  )
  pgName = `atlas-47-pg-${process.pid}`
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
  line('47_db', 'local')
}

function materializePin() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-47-'))
  const git = spawn('git', ['archive', '--format=tar', PIN], { cwd: repoRoot })
  const tar = spawn('tar', ['-x', '-C', dir])
  git.stdout.pipe(tar.stdin)
  return new Promise<string>((resolve, reject) => {
    let failed = false
    let gitCode = -1
    let tarCode = -1
    const fail = () => {
      if (failed) return
      failed = true
      rmSync(dir, { recursive: true, force: true })
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
        resolve(dir)
      } catch (error) {
        failed = true
        rmSync(dir, { recursive: true, force: true })
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

function buildServer(root: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['build'], {
      cwd: root,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err = `${err}${chunk.toString()}`.slice(-800)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(redact(err || 'build failed')))
    })
  })
}

async function boot(root: string) {
  await buildServer(root)
  const port = await freePort()
  const base = assertLocalBaseUrl(`http://127.0.0.1:${port}`)
  mkdirSync(artifacts, { recursive: true })
  const logFd = openSync(join(artifacts, `47-server-${port}.log`), 'a')
  const child = spawn('node', ['.output/server/index.mjs'], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      BETTER_AUTH_URL: base,
    },
    stdio: ['ignore', logFd, logFd],
  })
  children.push(child)
  child.unref()
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(`${base}/sign-in`)
      if (response.status === 200) {
        await response.text().catch(() => '')
        closeSync(logFd)
        line('47_port', port)
        return {
          base,
          stop: () => stopChild(child),
        }
      }
      await response.text().catch(() => '')
    } catch {
      // still binding
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  closeSync(logFd)
  await stopChild(child)
  throw new Error('local server did not start')
}

async function loadApp(): Promise<App> {
  const href = (rel: string) => pathToFileURL(join(repoRoot, rel)).href
  const pages = (await import(href('src/lib/pages.ts'))) as Pick<
    App,
    'createPage' | 'savePage' | 'getPageView'
  >
  const helpers = (await import(href('tests/helpers.ts'))) as Pick<
    App,
    'createUser'
  >
  const teams = (await import(href('src/lib/teams.ts'))) as Pick<
    App,
    'createTeam' | 'createInvite' | 'acceptInvite'
  >
  const db = (await import(href('src/lib/db.ts'))) as Pick<
    App,
    'getSql' | 'closeDb'
  >
  return { ...pages, ...helpers, ...teams, ...db }
}

async function migrate() {
  await runFile('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], process.env)
}

async function phonePage(browser: Browser) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  return { page, close: () => context.close() }
}

async function deskPage(browser: Browser) {
  const context = await browser.newContext({
    viewport: DESK,
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  return { page, close: () => context.close() }
}

async function signIn(page: Page, base: string, person: Person) {
  await page.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').waitFor()
  await page.locator('#email').fill(person.user.email)
  await page.locator('#password').fill(person.password)
  await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
  await page.locator('.app').waitFor()
}

async function openDoc(page: Page, ctx: Ctx, pageId: string) {
  await page.goto(`${ctx.base}/s/${ctx.spaceId}/p/${pageId}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('#page-title').waitFor()
  await page.evaluate(() => document.fonts.ready)
}

async function shot(page: Page, name: string) {
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({
    path: join(artifacts, name),
    animations: 'disabled',
    caret: 'hide',
  })
}

async function edges(page: Page) {
  return page.evaluate(({ width }) => {
    const bad: string[] = []
    for (const el of document.body.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement)) continue
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 && rect.height < 1) continue
      if (rect.right > width + 0.5) {
        const cls = String(el.className).slice(0, 40)
        bad.push(`${el.tagName}.${cls}:${Math.round(rect.right)}`)
      }
    }
    return {
      bad: bad.slice(0, 6).join(','),
      scroll: document.documentElement.scrollWidth > width + 1,
      scrollWidth: document.documentElement.scrollWidth,
    }
  }, PHONE)
}

async function cardBox(page: Page) {
  return page.locator('.auth .card').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.x, w: rect.width, right: rect.right }
  })
}

function cardFits(card: { x: number; w: number; right: number }) {
  return card.x >= 18 && card.right <= 372 && card.w <= 352 && card.w >= 340
}

async function fc1(ctx: Ctx) {
  const { page, close } = await phonePage(ctx.browser)
  try {
    await page.goto(`${ctx.base}/sign-in`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Sign in' }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    const emptyCard = await cardBox(page)
    const emptyEdges = await edges(page)
    await page.locator('#email').fill('nobody@example.com')
    await page.locator('#password').fill('wrong-password')
    await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
    await page.locator('.banner').waitFor()
    await page.locator('#password').fill('')
    const errorCard = await cardBox(page)
    const errorEdges = await edges(page)
    await shot(page, `47-${ctx.planted ? 'planted' : 'head'}-fc1-signin.png`)
    const bug =
      !cardFits(emptyCard) ||
      !cardFits(errorCard) ||
      emptyEdges.bad.length > 0 ||
      errorEdges.bad.length > 0 ||
      emptyEdges.scroll ||
      errorEdges.scroll
    line('47_fc1_empty_right', Math.round(emptyCard.right))
    line('47_fc1_error_right', Math.round(errorCard.right))
    line('47_fc1_empty_bad', emptyEdges.bad || 'none')
    line('47_fc1_error_bad', errorEdges.bad || 'none')
    line('47_fc1_scroll', emptyEdges.scroll || errorEdges.scroll)
    return bug
  } finally {
    await close()
  }
}

async function openPageMenu(page: Page) {
  const btn = page.locator('.page-menu-btn')
  await btn.waitFor()
  if ((await btn.getAttribute('aria-expanded')) !== 'true') {
    await btn.evaluate((el: HTMLButtonElement) => el.click())
  }
  await page.locator('.page-menu .menu').waitFor()
}

async function menuInside(page: Page) {
  return page.evaluate(({ width, height }) => {
    const menu = document.querySelector('.page-menu .menu')
    if (!(menu instanceof HTMLElement))
      return { ok: false, right: 0, items: 0, delete: false }
    const box = menu.getBoundingClientRect()
    const buttons = [...menu.querySelectorAll('button')]
    const deleteBtn = buttons.find(
      (button) => button.textContent.trim() === 'Delete page',
    )
    const itemOk = buttons.every((button) => {
      const rect = button.getBoundingClientRect()
      return (
        rect.left >= -0.5 &&
        rect.top >= -0.5 &&
        rect.right <= width + 0.5 &&
        rect.bottom <= height + 0.5
      )
    })
    const textOk = deleteBtn
      ? (() => {
          const node = deleteBtn.firstChild
          if (!node) return false
          const range = document.createRange()
          range.selectNodeContents(deleteBtn)
          const rect = range.getBoundingClientRect()
          return (
            rect.right <= width + 0.5 && rect.left >= -0.5 && rect.width > 40
          )
        })()
      : false
    return {
      ok: itemOk && textOk && box.right <= width - 8 + 0.5 && box.left >= -0.5,
      right: Math.round(box.right),
      items: buttons.length,
      delete: Boolean(deleteBtn),
    }
  }, PHONE)
}

async function fc2(ctx: Ctx) {
  const { page, close } = await phonePage(ctx.browser)
  try {
    await signIn(page, ctx.base, ctx.owner)
    await openDoc(page, ctx, ctx.ownerPage)
    await openPageMenu(page)
    const menu = await menuInside(page)
    await shot(page, `47-${ctx.planted ? 'planted' : 'head'}-fc2-menu.png`)
    line('47_fc2_right', menu.right)
    line('47_fc2_items', menu.items)
    line('47_fc2_delete', menu.delete)
    return !menu.ok
  } finally {
    await close()
  }
}

async function barState(page: Page) {
  return page.evaluate(() => {
    const crumbs = document.querySelector('.crumbs')
    const title = document.querySelector('.crumbs b')
    let chars = 0
    if (
      crumbs instanceof HTMLElement &&
      title instanceof HTMLElement &&
      title.firstChild
    ) {
      const node = title.firstChild
      const text = node.textContent ?? ''
      const limit = crumbs.getBoundingClientRect().right
      if (node.nodeType === Node.TEXT_NODE) {
        const range = document.createRange()
        for (let i = 1; i <= text.length; i += 1) {
          range.setStart(node, 0)
          range.setEnd(node, i)
          const rect = range.getBoundingClientRect()
          if (rect.width === 0) continue
          if (rect.right <= limit + 0.5) chars = i
          else break
        }
      }
    }
    const top = document.querySelector('.top')
    const pageScroll =
      document.documentElement.scrollWidth > window.innerWidth + 1
    let overflow = pageScroll
    const parents = [
      top,
      document.querySelector('.top .r'),
      document.querySelector('.top .mode'),
    ]
    for (const parent of parents) {
      if (!(parent instanceof HTMLElement)) {
        overflow = true
        continue
      }
      const box = parent.getBoundingClientRect()
      if (parent.scrollWidth > parent.clientWidth + 1) overflow = true
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement)) continue
        const style = getComputedStyle(child)
        if (style.display === 'none') continue
        const rect = child.getBoundingClientRect()
        if (rect.width < 1 && rect.height < 1) continue
        if (rect.left < box.left - 1 || rect.right > box.right + 1)
          overflow = true
        if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)
          overflow = true
      }
    }
    return {
      chars,
      overflow,
      height:
        top instanceof HTMLElement ? top.getBoundingClientRect().height : 0,
    }
  })
}

async function setLock(ctx: Ctx, pageId: string, userId: string | null) {
  const sql = ctx.app.getSql()
  if (userId) {
    await sql`update page set locked_by = ${userId}, locked_at = now() where id = ${pageId}`
  } else {
    await sql`update page set locked_by = null, locked_at = null where id = ${pageId}`
  }
}

async function fc3(ctx: Ctx) {
  const { page, close } = await phonePage(ctx.browser)
  try {
    await signIn(page, ctx.base, ctx.owner)
    await openDoc(page, ctx, ctx.ownerPage)
    const view = await barState(page)
    await enterEdit(page)
    const edit = await barState(page)
    await setLock(ctx, ctx.ownerPage, ctx.owner.user.id)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.lock-chip').waitFor()
    await page.evaluate(() => document.fonts.ready)
    const locked = await barState(page)
    await shot(page, `47-${ctx.planted ? 'planted' : 'head'}-fc3-locked.png`)
    line('47_fc3_view_chars', view.chars)
    line('47_fc3_edit_chars', edit.chars)
    line('47_fc3_locked_chars', locked.chars)
    line('47_fc3_view_overflow', view.overflow)
    line('47_fc3_edit_overflow', edit.overflow)
    line('47_fc3_locked_overflow', locked.overflow)
    const short = (state: { chars: number }) => state.chars < 12
    const bug =
      short(view) ||
      short(edit) ||
      short(locked) ||
      view.overflow ||
      edit.overflow ||
      locked.overflow ||
      view.height > 49 ||
      edit.height > 49 ||
      locked.height > 49
    return bug
  } finally {
    await setLock(ctx, ctx.ownerPage, null).catch(() => undefined)
    await close()
  }
}

async function menuText(page: Page) {
  return (await page.locator('.page-menu .menu').innerText()).replace(
    /\s+/g,
    ' ',
  )
}

async function fc4(ctx: Ctx) {
  const { page, close } = await phonePage(ctx.browser)
  try {
    await signIn(page, ctx.base, ctx.owner)
    await openDoc(page, ctx, ctx.ownerPage)
    const barCreate = await page.locator('.top .create-page').isVisible()
    await openPageMenu(page)
    const viewText = await menuText(page)
    const viewStatus = page.locator('.page-menu .menu .menu-status')
    const viewSaved =
      (await viewStatus.count()) > 0 && (await viewStatus.isVisible())
    await page
      .locator('.page-menu-btn')
      .evaluate((el: HTMLButtonElement) => el.click())
    await enterEdit(page)
    await openPageMenu(page)
    const editText = await menuText(page)
    const editStatus = page.locator('.page-menu .menu .menu-status')
    const editSaved =
      (await editStatus.count()) > 0 && (await editStatus.isVisible())
    const createReached =
      viewText.includes('Create page') && editText.includes('Create page')
    line('47_fc4_bar_create', barCreate)
    line('47_fc4_create', createReached)
    line('47_fc4_view_saved', viewSaved)
    line('47_fc4_edit_saved', editSaved)
    return barCreate || !createReached || !viewSaved || !editSaved
  } finally {
    await close()
  }
}

type Metric = Record<string, Box | null>

async function metric(page: Page, selectors: string[]) {
  return page.evaluate((names) => {
    const out: Record<
      string,
      { x: number; y: number; w: number; h: number } | null
    > = {}
    for (const sel of names) {
      const el = document.querySelector(sel)
      if (!(el instanceof HTMLElement)) {
        out[sel] = null
        continue
      }
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') {
        out[sel] = null
        continue
      }
      const rect = el.getBoundingClientRect()
      out[sel] = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }
    }
    return out
  }, selectors)
}

function differ(a: Metric, b: Metric) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const changed: string[] = []
  for (const key of keys) {
    const left = a[key]
    const right = b[key]
    if (!left && !right) continue
    if (!left || !right) {
      changed.push(key)
      continue
    }
    if (
      Math.abs(left.x - right.x) > 2 ||
      Math.abs(left.y - right.y) > 2 ||
      Math.abs(left.w - right.w) > 2 ||
      Math.abs(left.h - right.h) > 2
    ) {
      changed.push(key)
    }
  }
  return changed
}

const SIGN_IN = ['.auth .card']
const VIEW_BAR = [
  '.top',
  '.crumbs',
  '.mode-switch',
  '.mode-icon',
  '.top .create-page',
  '.page-menu-btn',
  '.top .r > .save',
]
const EDIT_BAR = [
  '.top',
  '.mode-switch',
  '.mode-icon',
  '.editing-chip',
  '.editing-chip .save',
  '.mode-done',
  '.top .create-page',
]
const LOCK_BAR = ['.top', '.lock-chip', '.mode-switch', '.top .create-page']

async function fc5(ctx: Ctx, pinRoot: string | null) {
  const head = await deskPage(ctx.browser)
  try {
    await head.page.goto(`${ctx.base}/sign-in`, {
      waitUntil: 'domcontentloaded',
    })
    await head.page.getByRole('heading', { name: 'Sign in' }).waitFor()
    await head.page.evaluate(() => document.fonts.ready)
    const headSign = await metric(head.page, SIGN_IN)
    await signIn(head.page, ctx.base, ctx.owner)
    await openDoc(head.page, ctx, ctx.ownerPage)
    const headView = await metric(head.page, VIEW_BAR)
    await enterEdit(head.page)
    const headEdit = await metric(head.page, EDIT_BAR)
    if (ctx.planted || !pinRoot) {
      await setLock(ctx, ctx.ownerPage, ctx.owner.user.id)
      await head.page.reload({ waitUntil: 'domcontentloaded' })
      await head.page.locator('.lock-chip').waitFor()
      const headLock = await metric(head.page, LOCK_BAR)
      const desktop =
        Boolean(headView['.mode-switch']) &&
        !headView['.mode-icon'] &&
        Boolean(headView['.top .create-page']) &&
        Boolean(headEdit['.mode-done']) &&
        (headLock['.lock-chip']?.h ?? 0) < 30 &&
        (headLock['.lock-chip']?.w ?? 0) > 80 &&
        (headSign['.auth .card']?.w ?? 0) > 370
      line('47_fc5_desktop', desktop)
      return !desktop
    }
    const pin = await boot(pinRoot)
    const other = await deskPage(ctx.browser)
    try {
      await other.page.goto(`${pin.base}/sign-in`, {
        waitUntil: 'domcontentloaded',
      })
      await other.page.getByRole('heading', { name: 'Sign in' }).waitFor()
      await other.page.evaluate(() => document.fonts.ready)
      const pinSign = await metric(other.page, SIGN_IN)
      await signIn(other.page, pin.base, ctx.owner)
      await other.page.goto(`${pin.base}/s/${ctx.spaceId}/p/${ctx.ownerPage}`, {
        waitUntil: 'domcontentloaded',
      })
      await other.page.locator('#page-title').waitFor()
      await other.page.evaluate(() => document.fonts.ready)
      const pinView = await metric(other.page, VIEW_BAR)
      await enterEdit(other.page)
      const pinEdit = await metric(other.page, EDIT_BAR)
      await setLock(ctx, ctx.ownerPage, ctx.owner.user.id)
      await head.page.reload({ waitUntil: 'domcontentloaded' })
      await other.page.reload({ waitUntil: 'domcontentloaded' })
      await head.page.locator('.lock-chip').waitFor()
      await other.page.locator('.lock-chip').waitFor()
      const headLock = await metric(head.page, LOCK_BAR)
      const pinLock = await metric(other.page, LOCK_BAR)
      await shot(head.page, '47-head-fc5-locked-1280.png')
      const changed = [
        ...differ(headSign, pinSign).map((key) => `sign:${key}`),
        ...differ(headView, pinView).map((key) => `view:${key}`),
        ...differ(headEdit, pinEdit).map((key) => `edit:${key}`),
        ...differ(headLock, pinLock).map((key) => `lock:${key}`),
      ]
      line('47_fc5_changed', changed.join(',') || 'none')
      return changed.length > 0
    } finally {
      await other.close()
      await pin.stop()
    }
  } finally {
    await setLock(ctx, ctx.ownerPage, null).catch(() => undefined)
    await head.close()
  }
}

async function pointHits(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    const width = window.innerWidth
    const height = window.innerHeight
    const inside =
      rect.left >= -0.5 &&
      rect.top >= -0.5 &&
      rect.right <= width + 0.5 &&
      rect.bottom <= height + 0.5
    return inside && (hit === el || (hit instanceof Node && el.contains(hit)))
  })
}

async function bannerInside(page: Page) {
  return page.evaluate(({ width }) => {
    const banner = document.querySelector('.retry')
    if (!(banner instanceof HTMLElement))
      return { bad: 'missing', scroll: true }
    const bad: string[] = []
    const nodes = [banner, ...banner.querySelectorAll('*')]
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 1 && rect.height < 1) continue
      if (rect.left < -0.5 || rect.right > width + 0.5) {
        bad.push(
          `${node.tagName}.${String(node.className).slice(0, 24)}:${Math.round(rect.right)}`,
        )
      }
    }
    return {
      bad: bad.slice(0, 6).join(','),
      scroll: document.documentElement.scrollWidth > width + 1,
    }
  }, PHONE)
}

async function fc6(ctx: Ctx) {
  const made = await ctx.app.createPage(ctx.owner.user.id, {
    spaceId: ctx.spaceId,
    title: 'Save banner notes',
  })
  const { page, close } = await phonePage(ctx.browser)
  let failSave = false
  try {
    await page.route(
      (url) => url.pathname.includes('_serverFn'),
      async (route) => {
        const body = route.request().postData() ?? ''
        if (
          failSave &&
          route.request().method() === 'POST' &&
          body.includes('"pageId"') &&
          body.includes('"body"')
        ) {
          await route.fulfill({
            status: 500,
            contentType: 'text/plain',
            body: 'no',
          })
          return
        }
        await route.continue()
      },
    )
    await signIn(page, ctx.base, ctx.owner)
    await openDoc(page, ctx, made.id)
    await enterEdit(page)
    failSave = true
    await page.locator('.doc-editor').click()
    await page.keyboard.type('fail')
    await page.locator('.retry').waitFor({ timeout: 10000 })
    const failedText = (await page.locator('.retry').innerText()).replace(
      /\s+/g,
      ' ',
    )
    const menuClosed =
      (await page.locator('.page-menu-btn').getAttribute('aria-expanded')) !==
      'true'
    const retryHit = await pointHits(page, '.retry button')
    const failedEdges = await bannerInside(page)
    failSave = false
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('#page-title').waitFor()
    await enterEdit(page)
    const current = await ctx.app.getPageView(ctx.owner.user.id, made.id)
    await ctx.app.savePage(ctx.owner.user.id, {
      pageId: made.id,
      title: 'Save banner notes',
      body: doc('newer'),
      updatedAt: current.updatedAt,
    })
    await page.locator('.doc-editor').click()
    await page.keyboard.type('stale')
    await page.locator('.retry').waitFor({ timeout: 10000 })
    const staleText = (await page.locator('.retry').innerText()).replace(
      /\s+/g,
      ' ',
    )
    const staleMenu =
      (await page.locator('.page-menu-btn').getAttribute('aria-expanded')) !==
      'true'
    const reloadHit = await pointHits(page, '.retry button')
    const staleEdges = await bannerInside(page)
    await shot(page, `47-${ctx.planted ? 'planted' : 'head'}-fc6-stale.png`)
    const failedOk =
      failedText.includes("Couldn't save.") &&
      failedText.includes('Retry') &&
      menuClosed &&
      retryHit &&
      !failedEdges.scroll &&
      failedEdges.bad.length === 0
    const staleOk =
      staleText.includes(
        'Someone else changed this page since you opened it.',
      ) &&
      staleText.includes('Reload') &&
      !staleText.includes('Retry') &&
      staleMenu &&
      reloadHit &&
      !staleEdges.scroll &&
      staleEdges.bad.length === 0
    line('47_fc6_failed', failedOk)
    line('47_fc6_stale', staleOk)
    line('47_fc6_failed_bad', failedEdges.bad || 'none')
    line('47_fc6_stale_bad', staleEdges.bad || 'none')
    return !failedOk || !staleOk
  } finally {
    await close()
  }
}

async function chipBox(page: Page) {
  const chip = page.locator('.lock-chip')
  if ((await chip.count()) === 0) return null
  return chip.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const hit = el.querySelector('.lock-hit')
    const hitVisible =
      hit instanceof HTMLElement && getComputedStyle(hit).display !== 'none'
    return {
      w: rect.width,
      h: rect.height,
      label: el.getAttribute('aria-label') ?? '',
      title: el.getAttribute('title') ?? '',
      hit: hitVisible,
    }
  })
}

async function lockFromMenu(page: Page) {
  await openPageMenu(page)
  await page
    .locator('.page-menu .menu')
    .getByRole('button', { name: 'Lock', exact: true })
    .click()
  await page.locator('.lock-chip').waitFor()
}

async function fc7(ctx: Ctx) {
  const { page, close } = await phonePage(ctx.browser)
  try {
    await signIn(page, ctx.base, ctx.member)
    await openDoc(page, ctx, ctx.memberPage)
    await lockFromMenu(page)
    const mine = await chipBox(page)
    const icon =
      Boolean(mine) &&
      mine!.hit &&
      Math.abs(mine!.w - 36) <= 2 &&
      Math.abs(mine!.h - 36) <= 2 &&
      mine!.label === 'Locked by Bea Member' &&
      mine!.title === 'Locked by Bea Member'
    if (!icon) {
      line('47_fc7_icon', false)
      line('47_fc7_w', mine ? Math.round(mine.w) : 0)
      return true
    }
    await page.locator('.lock-hit').click()
    await page.locator('.lock-chip').waitFor({ state: 'hidden' })
    await lockFromMenu(page)
    const relocked = await chipBox(page)
    await page.locator('.lock-hit').click()
    await page.locator('.lock-chip').waitFor({ state: 'hidden' })
    await lockFromMenu(page)
    await close()
    const owner = await phonePage(ctx.browser)
    try {
      await signIn(owner.page, ctx.base, ctx.owner)
      await openDoc(owner.page, ctx, ctx.memberPage)
      const ownerChip = await chipBox(owner.page)
      if (!ownerChip?.hit) {
        line('47_fc7_owner', false)
        return true
      }
      await owner.page.locator('.lock-hit').click()
      await owner.page.locator('.lock-chip').waitFor({ state: 'hidden' })
      await lockFromMenu(owner.page)
    } finally {
      await owner.close()
    }
    const other = await phonePage(ctx.browser)
    try {
      await signIn(other.page, ctx.base, ctx.other)
      await openDoc(other.page, ctx, ctx.memberPage)
      const blocked = await chipBox(other.page)
      await other.page.locator('.lock-chip').click({ force: true })
      await other.page.waitForTimeout(400)
      const stayed = (await other.page.locator('.lock-chip').count()) === 1
      await openPageMenu(other.page)
      const menu = await menuText(other.page)
      await other.page.setViewportSize(DESK)
      await other.page.locator('.lock-label').waitFor()
      const wide = await other.page.locator('.lock-chip').evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const label = el.querySelector('.lock-label')
        const shown =
          label instanceof HTMLElement &&
          getComputedStyle(label).position !== 'absolute'
        return (
          rect.height < 30 &&
          shown &&
          el.textContent.includes('Locked by Ada Owner')
        )
      })
      const noUnlock =
        !menu.includes('Unlock') &&
        blocked?.label === 'Locked by Ada Owner' &&
        !blocked.hit
      line('47_fc7_icon', true)
      line('47_fc7_relock', Boolean(relocked?.hit))
      line('47_fc7_member_blocked', noUnlock && stayed)
      line('47_fc7_member_1280', wide)
      return !relocked?.hit || !noUnlock || !stayed || !wide
    } finally {
      await other.close()
    }
  } finally {
    await setLock(ctx, ctx.memberPage, null).catch(() => undefined)
    await close().catch(() => undefined)
  }
}

async function openDrawer(page: Page) {
  if ((await page.locator('.side.open').count()) === 0) {
    await page.getByRole('button', { name: 'Open pages' }).click()
    await page.locator('.side.open').waitFor()
  }
}

async function closeDrawer(page: Page) {
  if ((await page.locator('.side.open').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.locator('.side.open').waitFor({ state: 'hidden' })
  }
}

async function rowMenuText(page: Page, title: string) {
  await openDrawer(page)
  const row = page.locator('.tree a.it').filter({ hasText: title }).first()
  await row.waitFor()
  await row
    .locator('xpath=following-sibling::button')
    .evaluate((el: HTMLButtonElement) => el.click())
  await page.locator('.tree .menu').waitFor()
  return (await page.locator('.tree .menu').innerText()).replace(/\s+/g, ' ')
}

function rules(text: string) {
  return {
    archive: text.includes('Archive'),
    delete: text.includes('Delete page'),
    move: text.includes('Move'),
  }
}

async function fc8(ctx: Ctx) {
  const { page, close } = await phonePage(ctx.browser)
  try {
    await signIn(page, ctx.base, ctx.other)
    await openDoc(page, ctx, ctx.ownerPage)
    await openPageMenu(page)
    const foreignPage = rules(await menuText(page))
    await page
      .locator('.page-menu-btn')
      .evaluate((el: HTMLButtonElement) => el.click())
    const foreignRow = rules(await rowMenuText(page, TITLE))
    await closeDrawer(page)
    await openDoc(page, ctx, ctx.memberPage)
    await openPageMenu(page)
    const teammatePage = rules(await menuText(page))
    const teammateRow = rules(await rowMenuText(page, 'Bea member phone notes'))
    await close()
    const member = await phonePage(ctx.browser)
    let ownPage = { archive: true, delete: false, move: true }
    let ownRow = { archive: true, delete: false, move: false }
    try {
      await signIn(member.page, ctx.base, ctx.member)
      await openDoc(member.page, ctx, ctx.memberPage)
      await openPageMenu(member.page)
      ownPage = rules(await menuText(member.page))
      ownRow = rules(await rowMenuText(member.page, 'Bea member phone notes'))
    } finally {
      await member.close()
    }
    const owner = await phonePage(ctx.browser)
    try {
      await signIn(owner.page, ctx.base, ctx.owner)
      await openDoc(owner.page, ctx, ctx.ownerPage)
      await openPageMenu(owner.page)
      const ownerPage = rules(await menuText(owner.page))
      const ownerRow = rules(await rowMenuText(owner.page, TITLE))
      const archive =
        foreignPage.archive ||
        foreignRow.archive ||
        teammatePage.archive ||
        teammateRow.archive ||
        ownPage.archive ||
        ownRow.archive ||
        ownerPage.archive ||
        ownerRow.archive
      const foreignDelete =
        foreignPage.delete ||
        foreignRow.delete ||
        teammatePage.delete ||
        teammateRow.delete
      const foreignMove =
        foreignPage.move ||
        foreignRow.move ||
        teammatePage.move ||
        teammateRow.move
      const ownOk =
        ownPage.delete && !ownPage.move && ownRow.move && ownRow.delete
      const ownerOk =
        ownerPage.delete && !ownerPage.move && ownerRow.move && ownerRow.delete
      line('47_fc8_archive', archive)
      line('47_fc8_foreign_delete', foreignDelete)
      line('47_fc8_foreign_move', foreignMove)
      line('47_fc8_own', ownOk)
      line('47_fc8_owner', ownerOk)
      return archive || foreignDelete || foreignMove || !ownOk || !ownerOk
    } finally {
      await owner.close()
    }
  } finally {
    await close().catch(() => undefined)
  }
}

async function fc9(ctx: Ctx) {
  const { page, close } = await phonePage(ctx.browser)
  try {
    await signIn(page, ctx.base, ctx.owner)
    await openDoc(page, ctx, ctx.ownerPage)
    await enterEdit(page)
    await page.locator('.tool button').first().waitFor()
    const result = await page.evaluate(() => {
      const bar = document.querySelector('.tool')
      if (!(bar instanceof HTMLElement))
        return { count: 0, reached: 0, pageScroll: true }
      const buttons = [...bar.querySelectorAll('button')]
      let reached = 0
      for (const button of buttons) {
        let rect = button.getBoundingClientRect()
        let box = bar.getBoundingClientRect()
        if (rect.left < box.left - 1) bar.scrollLeft -= box.left - rect.left
        rect = button.getBoundingClientRect()
        box = bar.getBoundingClientRect()
        if (rect.right > box.right + 1) bar.scrollLeft += rect.right - box.right
        rect = button.getBoundingClientRect()
        box = bar.getBoundingClientRect()
        const pageScroll =
          document.documentElement.scrollWidth > window.innerWidth + 1
        const inside =
          rect.left >= box.left - 1 &&
          rect.right <= box.right + 1 &&
          rect.left >= -1 &&
          rect.right <= window.innerWidth + 1 &&
          !pageScroll
        if (inside) reached += 1
      }
      bar.scrollLeft = bar.scrollWidth
      const pageScroll =
        document.documentElement.scrollWidth > window.innerWidth + 1
      return { count: buttons.length, reached, pageScroll }
    })
    await shot(page, `47-${ctx.planted ? 'planted' : 'head'}-fc9-toolbar.png`)
    line('47_fc9_count', result.count)
    line('47_fc9_reached', result.reached)
    line('47_fc9_page_scroll', result.pageScroll)
    return (
      result.count < 12 || result.reached !== result.count || result.pageScroll
    )
  } finally {
    await close()
  }
}

async function roster(app: App) {
  const owner = await app.createUser('Ada Owner')
  const member = await app.createUser('Bea Member')
  const other = await app.createUser('Cam Other')
  const team = await app.createTeam(owner.user.id, 'Phone')
  const memberInvite = await app.createInvite(
    owner.user.id,
    team.id,
    member.user.id,
  )
  await app.acceptInvite(member.user.id, memberInvite.id)
  const otherInvite = await app.createInvite(
    owner.user.id,
    team.id,
    other.user.id,
  )
  await app.acceptInvite(other.user.id, otherInvite.id)
  const owned = await app.createPage(owner.user.id, {
    spaceId: team.spaceId,
    title: TITLE,
  })
  const made = await app.createPage(member.user.id, {
    spaceId: team.spaceId,
    title: 'Bea member phone notes',
  })
  return {
    owner,
    member,
    other,
    spaceId: team.spaceId,
    ownerPage: owned.id,
    memberPage: made.id,
  }
}

const steps = [
  ['fc1', fc1],
  ['fc2', fc2],
  ['fc3', fc3],
  ['fc4', fc4],
  ['fc6', fc6],
  ['fc7', fc7],
  ['fc8', fc8],
  ['fc9', fc9],
] as const

async function main() {
  const mode = process.argv[2] ?? ''
  const planted = mode.endsWith('-planted')
  const which = mode.replace(/-planted$/, '')
  const known = [
    'fc1',
    'fc2',
    'fc3',
    'fc4',
    'fc5',
    'fc6',
    'fc7',
    'fc8',
    'fc9',
    'all',
  ]
  if (!known.includes(which)) {
    console.error(
      'usage: issue47-fail.ts fc1|fc2|fc3|fc4|fc5|fc6|fc7|fc8|fc9|all[-planted]',
    )
    process.exit(2)
  }
  mkdirSync(artifacts, { recursive: true })
  line('47_pin', PIN)
  line('47_planted', planted)
  line('47_artifacts', artifacts)
  await ensureDatabase()
  const secret = Buffer.from(
    crypto.getRandomValues(new Uint8Array(24)),
  ).toString('hex')
  remember(secret)
  process.env.BETTER_AUTH_SECRET = secret
  process.env.ADMIN_API_SECRET = secret
  const portHint = await freePort()
  process.env.BETTER_AUTH_URL = `http://127.0.0.1:${portHint}`
  await migrate()
  const pinRoot =
    planted || which === 'fc5' || which === 'all'
      ? await materializePin()
      : null
  const booted = await boot(planted && pinRoot ? pinRoot : repoRoot)
  process.env.BETTER_AUTH_URL = booted.base
  const app = await loadApp()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  let bug = false
  try {
    const people = await roster(app)
    const ctx: Ctx = { ...people, base: booted.base, planted, app, browser }
    if (which === 'all' || which === 'fc5') {
      const fc5bug = await fc5(ctx, pinRoot)
      line('47_fc5_bug', fc5bug)
      line('47_fc5', fc5bug ? 'fail' : 'pass')
      bug = fc5bug
    }
    for (const [name, fn] of steps) {
      if (which !== 'all' && which !== name) continue
      const failed = await fn(ctx)
      line(`47_${name}_bug`, failed)
      line(`47_${name}`, failed ? 'fail' : 'pass')
      bug = bug || failed
    }
    line('47_result', bug ? 'fail' : 'pass')
    return bug
  } finally {
    await browser.close().catch(() => undefined)
    await app.closeDb().catch(() => undefined)
    await booted.stop()
    if (pinRoot) rmSync(pinRoot, { recursive: true, force: true })
  }
}

main()
  .then(async (bug) => {
    await cleanup()
    process.exit(bug ? 1 : 0)
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'issue47 failed'
    console.error(redact(message))
    await cleanup()
    process.exit(2)
  })
