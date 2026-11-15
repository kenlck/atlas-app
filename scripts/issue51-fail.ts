import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { artifactDirs } from './artifact-dir.ts'
import { stopChild } from './stop-child.ts'
import { assertLocalDatabaseUrl, submitAuthForm } from './verify-local.ts'

const PIN = '7addaad4a4ff50a2761dcd41afb78bba05ef3550'
const FC18_PIN = '7e9c2776ee1fc2b4e638d18c57df662278c44d6d'
const BODY_MAX = 1024 * 1024
const repoRoot = join(import.meta.dirname, '..')
const tsxBin = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
const arg = process.argv[2] ?? ''
const planted = arg.endsWith('-planted')
const id = planted ? arg.slice(0, -'-planted'.length) : arg
const side = planted ? 'planted' : 'head'

type View = {
  id: string
  title: string
  updatedAt: string
  body: unknown
  parentId?: string | null
}

type Account = {
  user: { id: string; email: string; name: string }
  password: string
  space: { id: string }
}

type App = {
  createPage: (userId: string, input: Record<string, unknown>) => Promise<View>
  savePage: (userId: string, input: Record<string, unknown>) => Promise<View>
  renamePage: (userId: string, input: Record<string, unknown>) => Promise<View>
  movePage: (userId: string, input: Record<string, unknown>) => Promise<View>
  getPageView: (userId: string, pageId: string) => Promise<View>
  setPageLock: (userId: string, pageId: string, locked: boolean) => Promise<View>
  refreshDocText: (userId: string, pageId: string, tokenId: string | null) => Promise<void>
  createUser: (name?: string) => Promise<Account>
  closeDb: () => Promise<void>
  getDb: () => {
    transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
    select: (shape: Record<string, unknown>) => {
      from: (table: unknown) => {
        where: (clause: unknown) => Promise<Array<Record<string, unknown>>>
      }
    }
  }
  schema: { page: { id: unknown; body: unknown; bodyText: unknown; spaceId: unknown; parentId: unknown } }
  createApiToken: (
    userId: string,
    input: { name: string; scope: string; expiry: string },
  ) => Promise<{ id: string; token: string }>
  updatePageForToken: (
    userId: string,
    tokenId: string,
    input: { pageId: string; body?: unknown; updatedAt: unknown },
  ) => Promise<View>
  parseSavePayload: (value: unknown) => { pageId: string; title: string; body: unknown } | null
  handleMcp: (request: Request) => Promise<Response>
  handlePageSave: (request: Request) => Promise<Response>
  moveFailureToast?: (error: unknown) => string
}

type Db = {
  select: () => {
    from: (table: unknown) => {
      where: (clause: unknown) => {
        limit: (n: number) => { for: (mode: 'update') => Promise<unknown> }
      }
    }
  }
  update: (table: unknown) => {
    set: (values: unknown) => { where: (clause: unknown) => Promise<unknown> }
  }
}

const secrets: string[] = []
const children: Array<ReturnType<typeof spawn>> = []
const temps: string[] = []
let pgName = ''
let pgEnv = ''
let stopping = false

function line(key: string, value: string | number | boolean) {
  console.log(`51_${id}_${side}_${key}=${value}`)
}

function remember(value: string) {
  if (value.length > 0) secrets.push(value)
}

function redact(text: string) {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
}

function doc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function statusOf(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return 500
}

async function attempt(run: () => Promise<unknown>) {
  try {
    await run()
    return 200
  } catch (error) {
    return statusOf(error)
  }
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

function runFile(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
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
  const port = await freePort()
  if (port === 5432) throw new Error('refusing database port 5432')
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('hex')
  remember(password)
  pgEnv = join(tmpdir(), `atlas-51-${process.pid}.env`)
  writeFileSync(pgEnv, `POSTGRES_USER=atlas\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=atlas\n`, {
    mode: 0o600,
  })
  pgName = `atlas-51-pg-${process.pid}`
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
    ready = await runFile('docker', ['exec', pgName, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'atlas']).then(
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

function ensureAuth(base = 'http://127.0.0.1:9') {
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    process.env.BETTER_AUTH_SECRET = 'issue51-fail-secret-not-a-credential'
  }
  remember(process.env.BETTER_AUTH_SECRET)
  if (!process.env.ADMIN_API_SECRET || process.env.ADMIN_API_SECRET.length < 32) {
    process.env.ADMIN_API_SECRET = 'issue51-fail-admin-not-a-credential'
  }
  remember(process.env.ADMIN_API_SECRET)
  process.env.BETTER_AUTH_URL = base
  process.env.BETTER_AUTH_TELEMETRY = '0'
}

async function migrate() {
  await runFile('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'])
}

function materialize(sha = PIN) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-51-'))
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

function show(path: string) {
  return planted
    ? execFileSync('git', ['show', `${PIN}:${path}`], { cwd: repoRoot, encoding: 'utf8' })
    : readFileSync(join(repoRoot, path), 'utf8')
}

async function loadApp(root: string): Promise<App> {
  const href = (rel: string) => pathToFileURL(join(root, rel)).href
  const pages = (await import(href('src/lib/pages.ts'))) as App
  const helpers = (await import(href('tests/helpers.ts'))) as Pick<App, 'createUser'>
  const db = (await import(href('src/lib/db.ts'))) as Pick<App, 'closeDb' | 'getDb'>
  const schema = (await import(href('src/lib/schema.ts'))) as App['schema']
  const tokens = (await import(href('src/lib/api-tokens.ts'))) as Pick<App, 'createApiToken'>
  let parseSavePayload: App['parseSavePayload'] = () => null
  try {
    const input = (await import(href('src/lib/page-input.ts'))) as Pick<App, 'parseSavePayload'>
    if (typeof input.parseSavePayload === 'function') parseSavePayload = input.parseSavePayload
  } catch {
    parseSavePayload = () => null
  }
  const mcp = (await import(href('src/lib/mcp.ts'))) as Pick<App, 'handleMcp'>
  const save = (await import(href('src/lib/page-save-request.ts'))) as Pick<App, 'handlePageSave'>
  let moveFailureToast: App['moveFailureToast']
  try {
    const lock = (await import(href('src/lib/page-lock-message.ts'))) as {
      moveFailureToast?: App['moveFailureToast']
    }
    moveFailureToast = lock.moveFailureToast
  } catch {
    moveFailureToast = undefined
  }
  return {
    createPage: pages.createPage,
    savePage: pages.savePage,
    renamePage: pages.renamePage,
    movePage: pages.movePage,
    getPageView: pages.getPageView,
    setPageLock: pages.setPageLock,
    refreshDocText: pages.refreshDocText,
    createUser: helpers.createUser,
    closeDb: db.closeDb,
    getDb: db.getDb,
    schema,
    createApiToken: tokens.createApiToken,
    updatePageForToken: pages.updatePageForToken,
    parseSavePayload,
    handleMcp: mcp.handleMcp,
    handlePageSave: save.handlePageSave,
    moveFailureToast,
  }
}

async function pageCount(app: App, spaceId: string) {
  const rows = await app
    .getDb()
    .select({ id: app.schema.page.id })
    .from(app.schema.page)
    .where(eq(app.schema.page.spaceId as never, spaceId))
  return rows.length
}

async function mcpStatus(app: App, token: string, name: string, args: Record<string, unknown>) {
  remember(token)
  try {
    const response = await app.handleMcp(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }),
    )
    return response.status
  } catch {
    return 500
  }
}

async function fc1(app: App) {
  const account = await app.createUser('Body')
  const made = await app.createPage(account.user.id, { spaceId: account.space.id, title: 'Body' })
  const marker = `H51${'x'.repeat(BODY_MAX)}`
  const over = await attempt(() =>
    app.savePage(account.user.id, {
      pageId: made.id,
      title: 'Body',
      body: doc(marker),
      updatedAt: made.updatedAt,
    }),
  )
  const after = await app.getPageView(account.user.id, made.id)
  const stored = JSON.stringify(after.body).includes('H51')
  const small = await attempt(() =>
    app.savePage(account.user.id, {
      pageId: made.id,
      title: 'Body',
      body: doc('hello'),
      updatedAt: after.updatedAt,
    }),
  )
  const request = await app
    .handlePageSave(
      new Request(process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:9', {
        method: 'POST',
        headers: {
          origin: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:9',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pageId: made.id, title: 'Body', body: doc(marker), updatedAt: made.updatedAt }),
      }),
    )
    .then((response) => response.status)
  line('over', over)
  line('stored', stored)
  line('small', small)
  line('request', request)
  return over === 413 && stored === false && small === 200 && request === 413
}

async function fc2(app: App) {
  const account = await app.createUser('Title')
  const made = await app.createPage(account.user.id, { spaceId: account.space.id, title: 'Title' })
  const before = await pageCount(app, account.space.id)
  const long = 'T'.repeat(201)
  const rename = await attempt(() =>
    app.renamePage(account.user.id, { pageId: made.id, title: long }),
  )
  const renamed = await app.getPageView(account.user.id, made.id)
  const token = await app.createApiToken(account.user.id, {
    name: 'fc2',
    scope: 'read_write',
    expiry: '30d',
  })
  const created = await mcpStatus(app, token.token, 'create_page', {
    space_id: account.space.id,
    title: long,
  })
  const after = await pageCount(app, account.space.id)
  const ok = await attempt(() =>
    app.renamePage(account.user.id, { pageId: made.id, title: 'U'.repeat(200) }),
  )
  line('rename', rename)
  line('unchanged', renamed.title === 'Title')
  line('mcp', created)
  line('count_same', after === before)
  line('ok', ok)
  return rename === 400 && renamed.title === 'Title' && created === 400 && after === before && ok === 200
}

async function fc3(app: App) {
  const account = await app.createUser('Types')
  const made = await app.createPage(account.user.id, { spaceId: account.space.id, title: 'Kept' })
  const child = await app.createPage(account.user.id, {
    spaceId: account.space.id,
    title: 'Child',
    parentId: made.id,
  })
  const before = await pageCount(app, account.space.id)
  const rename = await attempt(() =>
    app.renamePage(account.user.id, { pageId: made.id, title: 1 }),
  )
  const renamed = await app.getPageView(account.user.id, made.id)
  const create = await attempt(() =>
    app.createPage(account.user.id, { spaceId: account.space.id, title: 1 }),
  )
  const after = await pageCount(app, account.space.id)
  const move = await attempt(() => app.movePage(account.user.id, { pageId: child.id, parentId: 1 }))
  const moved = await app.getPageView(account.user.id, child.id)
  line('rename', rename)
  line('title', renamed.title === 'Kept')
  line('create', create)
  line('count_same', after === before)
  line('move', move)
  line('parent', moved.parentId === made.id)
  return (
    rename === 400 &&
    renamed.title === 'Kept' &&
    create === 400 &&
    after === before &&
    move === 400 &&
    moved.parentId === made.id
  )
}

async function fc4(app: App) {
  const account = await app.createUser('Malformed')
  const made = await app.createPage(account.user.id, { spaceId: account.space.id, title: 'Keep' })
  await app.savePage(account.user.id, {
    pageId: made.id,
    title: 'Keep',
    body: doc('original'),
    updatedAt: made.updatedAt,
  })
  const current = await app.getPageView(account.user.id, made.id)
  const bad = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: { a: 1 } }] }],
  }
  const save = await attempt(() =>
    app.savePage(account.user.id, {
      pageId: made.id,
      title: 'Keep',
      body: bad,
      updatedAt: current.updatedAt,
    }),
  )
  const after = await app.getPageView(account.user.id, made.id)
  const stored = JSON.stringify(after.body).includes('"a":1') || JSON.stringify(after.body).includes('"a": 1')
  const token = await app.createApiToken(account.user.id, {
    name: 'fc4',
    scope: 'read',
    expiry: '30d',
  })
  const read = await mcpStatus(app, token.token, 'get_page', { page_id: made.id })
  line('save', save)
  line('stored', stored)
  line('get_page', read)
  return save === 400 && stored === false && read === 200
}

function bootCheck(secret: string, root: string) {
  remember(secret)
  const child = spawn(process.execPath, [tsxBin, 'scripts/boot-check.ts'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: 'http://127.0.0.1:9',
      ADMIN_API_SECRET: 'issue51-fail-admin-not-a-credential',
    },
  })
  return new Promise<{ status: number; leaked: boolean; message: boolean }>((resolve, reject) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        status: code ?? 1,
        leaked: out.includes(secret),
        message: out.includes('BETTER_AUTH_SECRET must be at least 32 characters'),
      })
    })
  })
}

async function fc5(_app: App, root: string) {
  const short = await bootCheck('short-secret', root)
  const long = await bootCheck('a'.repeat(32), root)
  line('short_status', short.status)
  line('short_message', short.message)
  line('short_leaked', short.leaked)
  line('long_status', long.status)
  line('long_leaked', long.leaked)
  return short.status !== 0 && short.message && !short.leaked && long.status === 0 && !long.leaked
}

async function fc6(app: App) {
  const account = await app.createUser('Board')
  const board = await app.createPage(account.user.id, {
    spaceId: account.space.id,
    title: 'Board',
    kind: 'whiteboard',
  })
  const first = await app.savePage(account.user.id, {
    pageId: board.id,
    title: 'One',
    body: board.body,
    updatedAt: board.updatedAt,
  })
  const stale = await attempt(() =>
    app.savePage(account.user.id, {
      pageId: board.id,
      title: 'Two',
      body: board.body,
      updatedAt: board.updatedAt,
    }),
  )
  const after = await app.getPageView(account.user.id, board.id)
  const fresh = await attempt(() =>
    app.savePage(account.user.id, {
      pageId: board.id,
      title: 'Three',
      body: board.body,
      updatedAt: after.updatedAt,
    }),
  )
  const omitted = await attempt(() =>
    app.savePage(account.user.id, {
      pageId: board.id,
      title: 'Four',
      body: board.body,
    }),
  )
  line('first', first.title === 'One')
  line('stale', stale)
  line('kept', after.title === 'One')
  line('fresh', fresh)
  line('omitted', omitted)
  return first.title === 'One' && stale === 409 && after.title === 'One' && fresh === 200 && omitted === 200
}

async function fc7(app: App) {
  const account = await app.createUser('Index')
  const made = await app.createPage(account.user.id, { spaceId: account.space.id, title: 'Index' })
  const saved = await app.savePage(account.user.id, {
    pageId: made.id,
    title: 'Index',
    body: doc('oldword51fc7'),
    updatedAt: made.updatedAt,
  })
  let releaseLock = () => {}
  let releaseCommit = () => {}
  const locked = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  const untilCommit = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  const holder = app.getDb().transaction(async (tx) => {
    await tx.select().from(app.schema.page).where(eq(app.schema.page.id as never, made.id)).limit(1).for('update')
    releaseLock()
    await untilCommit
    await tx.update(app.schema.page).set({ body: doc('newword51fc7') }).where(eq(app.schema.page.id as never, made.id))
  })
  await locked
  const refresh = app.refreshDocText(account.user.id, made.id, null)
  const saw = await waitForLock()
  releaseCommit()
  await holder
  await refresh
  const rows = await app
    .getDb()
    .select({ bodyText: app.schema.page.bodyText })
    .from(app.schema.page)
    .where(eq(app.schema.page.id as never, made.id))
  const bodyText = String(rows[0]?.bodyText ?? '')
  line('saw_wait', saw)
  line('body_text', bodyText.includes('newword51fc7') && !bodyText.includes('oldword51fc7'))
  void saved
  return saw && bodyText.includes('newword51fc7') && !bodyText.includes('oldword51fc7')
}

async function waitForLock() {
  const url = process.env.DATABASE_URL
  if (!url) return false
  const sql = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} })
  try {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n
        from pg_stat_activity
        where state = 'active'
          and wait_event_type = 'Lock'
          and pid <> pg_backend_pid()
      `
      if (Number(rows[0]?.n ?? 0) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return false
  } finally {
    await sql.end({ timeout: 1 })
  }
}

async function fc8(app: App) {
  const toast = app.moveFailureToast
  const wired = show('src/components/AppFrame.tsx').includes('moveFailureToast(failure)')
  if (!toast) {
    line('wired', wired)
    line('locked', false)
    line('other', false)
    return false
  }
  const locked = toast(Object.assign(new Error('Page is locked by Ada'), { status: 423 }))
  const other = toast(new Error('network down'))
  line('wired', wired)
  line('locked', locked === 'Page is locked by Ada')
  line('other', other === "You can't move this page.")
  return wired && locked === 'Page is locked by Ada' && other === "You can't move this page."
}

async function fc9() {
  const issue49 = show('scripts/issue49-fail.ts')
  const issue50 = show('scripts/issue50-fail.ts')
  const dir = mkdtempSync(join(tmpdir(), 'atlas-51-art-'))
  temps.push(dir)
  process.env.ARTIFACTS_DIR = dir
  const dirs = artifactDirs(repoRoot, 'abc')
  delete process.env.ARTIFACTS_DIR
  const configurable = issue49.includes('artifactDirs') && issue50.includes('artifactDirs')
  const only = dirs.length === 1 && dirs[0] === dir
  line('configurable', configurable)
  line('only_configured', only)
  return configurable && only
}

function spawnDetached(command: string, args: string[], cwd = repoRoot) {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' })
  children.push(child)
  return child
}

async function exitedWithin(child: ReturnType<typeof spawn>, ms: number) {
  if (child.exitCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function fc10() {
  const caller = show('scripts/issue50-fail.ts')
  const helper = readFileSync(join(repoRoot, 'scripts/stop-child.ts'), 'utf8')
  const has = caller.includes('stopChild') && helper.includes("'SIGKILL'")
  const appHandler = show('src/server/production-env.ts').includes('function installStopSignals')
  const child = spawnDetached(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'])
  await new Promise((resolve) => setTimeout(resolve, 200))
  let exited = false
  if (planted) {
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    exited = await exitedWithin(child, 800)
    if (!exited) await stopChild(child, 200)
  } else {
    await stopChild(child, 1000)
    exited = child.exitCode !== null || child.signalCode !== null
  }
  line('handler', has)
  line('exited', exited)
  line('app_handler', appHandler)
  return has && exited && !appHandler
}

const BAD_BODIES: Array<{ name: string; body: unknown; stored: (json: string) => boolean }> = [
  {
    name: 'marks_string',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: 'bold' }] }],
    },
    stored: (json) => json.includes('"marks":"bold"') || json.includes('"marks": "bold"'),
  },
  {
    name: 'marks_null',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [null] }] }],
    },
    stored: (json) => json.includes('[null]'),
  },
  {
    name: 'cell_attrs',
    body: {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableCell', attrs: 'x', content: [] }] },
          ],
        },
      ],
    },
    stored: (json) => json.includes('"attrs":"x"') || json.includes('"attrs": "x"'),
  },
  {
    name: 'list_attrs',
    body: { type: 'doc', content: [{ type: 'orderedList', attrs: 'x', content: [] }] },
    stored: (json) => json.includes('"attrs":"x"') || json.includes('"attrs": "x"'),
  },
  {
    name: 'link_attrs',
    body: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a', marks: [{ type: 'link', attrs: 'ab' }] }],
        },
      ],
    },
    stored: (json) => json.includes('"attrs":"ab"') || json.includes('"attrs": "ab"'),
  },
]

async function fc18(app: App) {
  const account = await app.createUser('Marks')
  const writer = await app.createApiToken(account.user.id, {
    name: 'fc18-write',
    scope: 'read_write',
    expiry: '30d',
  })
  const reader = await app.createApiToken(account.user.id, {
    name: 'fc18-read',
    scope: 'read',
    expiry: '30d',
  })
  let ok = true
  for (const item of BAD_BODIES) {
    const browser = await saveBad(app, account, reader.token, item.body, item.stored, (userId, pageId, body, updatedAt) => {
      const parsed = app.parseSavePayload({ pageId, title: 'Keep', body, updatedAt })
      if (!parsed) return Promise.resolve(400)
      return attempt(() =>
        app.savePage(userId, { pageId, title: 'Keep', body: parsed.body, updatedAt }),
      )
    })
    const token = await saveBad(app, account, reader.token, item.body, item.stored, (userId, pageId, body, updatedAt) =>
      attempt(() => app.updatePageForToken(userId, writer.id, { pageId, body, updatedAt })),
    )
    const http = await pageSaveStatus(app, browser.pageId, item.body, browser.updatedAt)
    line(`${item.name}_browser_save`, browser.save)
    line(`${item.name}_browser_stored`, browser.stored)
    line(`${item.name}_browser_get_page`, browser.read)
    line(`${item.name}_browser_http`, http)
    line(`${item.name}_token_save`, token.save)
    line(`${item.name}_token_stored`, token.stored)
    line(`${item.name}_token_get_page`, token.read)
    const fixed =
      browser.save === 400 &&
      browser.stored === false &&
      browser.read === 200 &&
      http === 400 &&
      token.save === 400 &&
      token.stored === false &&
      token.read === 200
    ok = ok && fixed
  }
  const goodBody = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'ok', marks: [{ type: 'bold' }] }] },
      { type: 'orderedList', attrs: { start: 2 }, content: [] },
    ],
  }
  const goodPage = await app.createPage(account.user.id, { spaceId: account.space.id, title: 'Keep' })
  const seeded = await app.savePage(account.user.id, {
    pageId: goodPage.id,
    title: 'Keep',
    body: doc('original'),
    updatedAt: goodPage.updatedAt,
  })
  const goodBrowser = await attempt(() =>
    app.savePage(account.user.id, {
      pageId: goodPage.id,
      title: 'Keep',
      body: goodBody,
      updatedAt: seeded.updatedAt,
    }),
  )
  const afterGood = await app.getPageView(account.user.id, goodPage.id)
  const goodToken = await attempt(() =>
    app.updatePageForToken(account.user.id, writer.id, {
      pageId: goodPage.id,
      body: goodBody,
      updatedAt: afterGood.updatedAt,
    }),
  )
  line('good_browser', goodBrowser)
  line('good_token', goodToken)
  return ok && goodBrowser === 200 && goodToken === 200
}

async function saveBad(
  app: App,
  account: Account,
  readToken: string,
  body: unknown,
  storedAs: (json: string) => boolean,
  write: (userId: string, pageId: string, body: unknown, updatedAt: string) => Promise<number>,
) {
  const made = await app.createPage(account.user.id, { spaceId: account.space.id, title: 'Keep' })
  const seeded = await app.savePage(account.user.id, {
    pageId: made.id,
    title: 'Keep',
    body: doc('original'),
    updatedAt: made.updatedAt,
  })
  const save = await write(account.user.id, made.id, body, seeded.updatedAt)
  const after = await app.getPageView(account.user.id, made.id)
  const read = await mcpStatus(app, readToken, 'get_page', { page_id: made.id })
  return { pageId: made.id, updatedAt: after.updatedAt, save, stored: storedAs(JSON.stringify(after.body)), read }
}

async function pageSaveStatus(app: App, pageId: string, body: unknown, updatedAt: string) {
  try {
    const response = await app.handlePageSave(
      new Request(process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:9', {
        method: 'POST',
        headers: {
          origin: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:9',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pageId, title: 'Keep', body, updatedAt }),
      }),
    )
    return response.status
  } catch {
    return 500
  }
}

async function bootDev(root: string) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  ensureAuth(base)
  const child = spawn('pnpm', ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    detached: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BETTER_AUTH_URL: base },
    stdio: 'ignore',
  })
  children.push(child)
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('dev server exited')
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
  throw new Error('dev server did not start')
}

async function signIn(page: Page, base: string, account: Account) {
  await page.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const field = document.getElementById('email')
    if (!field) return false
    return Object.getOwnPropertyNames(field).some((key) => key.startsWith('__reactProps$'))
  })
  await page.locator('#email').fill(account.user.email)
  await page.locator('#password').fill(account.password)
  remember(account.password)
  await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
  await page.waitForFunction(() => !location.pathname.startsWith('/sign-in'))
}

async function browserSession(app: App, root: string) {
  const base = await bootDev(root)
  const account = await app.createUser('Ada')
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(20000)
  await signIn(page, base, account)
  return {
    page,
    base,
    account,
    close: async () => {
      await browser.close()
    },
  }
}

async function waitHydrated(page: Page, selector: string) {
  await page.waitForFunction((target) => {
    const node = document.querySelector(target)
    if (!node) return false
    return Object.getOwnPropertyNames(node).some((key) => key.startsWith('__reactProps'))
  }, selector)
}

async function openPageMenu(page: Page) {
  const button = page.locator('.page-menu-btn')
  await button.waitFor()
  await waitHydrated(page, '.page-menu-btn')
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  await page.locator('.page-menu .menu').waitFor()
  await page.locator('.page-menu .menu button.danger').click()
  await page.locator('.delete-modal').waitFor()
}

function cssColor(value: string) {
  return value.replace(/\s+/g, '')
}

async function fc11(app: App, root: string) {
  const session = await browserSession(app, root)
  try {
    const made = await app.createPage(session.account.user.id, {
      spaceId: session.account.space.id,
      title: 'Delete me',
    })
    await session.page.goto(`${session.base}/s/${session.account.space.id}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await session.page.locator('.page-menu-btn').waitFor()
    await openPageMenu(session.page)
    const measured = await session.page.locator('.delete-actions .btn.danger').evaluate((node) => {
      const button = node as HTMLButtonElement
      const style = getComputedStyle(button)
      const box = button.getBoundingClientRect()
      return {
        text: button.textContent.trim(),
        height: Math.round(box.height),
        bg: style.backgroundColor,
        color: style.color,
      }
    })
    line('text', measured.text === 'Delete page')
    line('height', measured.height)
    line('bg', cssColor(measured.bg) === 'rgb(180,35,24)')
    line('color', cssColor(measured.color) === 'rgb(255,255,255)')
    return (
      measured.text === 'Delete page' &&
      measured.height === 36 &&
      cssColor(measured.bg) === 'rgb(180,35,24)' &&
      cssColor(measured.color) === 'rgb(255,255,255)'
    )
  } finally {
    await session.close()
  }
}

async function fc12(app: App, root: string) {
  const session = await browserSession(app, root)
  try {
    const title = `Stay ${Date.now()}`
    const made = await app.createPage(session.account.user.id, {
      spaceId: session.account.space.id,
      title,
    })
    await session.page.goto(`${session.base}/s/${session.account.space.id}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await session.page.locator('.tree a.it', { hasText: title }).waitFor()
    await openPageMenu(session.page)
    await session.page.waitForFunction(() => {
      const cancel = document.querySelector('.delete-actions .btn.secondary')
      return Boolean(cancel) && document.activeElement === cancel
    })
    await session.page.keyboard.press('Enter')
    await session.page.waitForTimeout(200)
    const closed = (await session.page.locator('.delete-modal').count()) === 0
    const remains = (await session.page.locator('.tree a.it', { hasText: title }).count()) === 1
    if (!closed) {
      line('cancel_closed', closed)
      line('remains', remains)
      line('confirm_stayed', false)
      line('still', remains)
      return false
    }
    await openPageMenu(session.page)
    await session.page.locator('.delete-actions .btn.danger').focus()
    await session.page.keyboard.press('Enter')
    await session.page.waitForTimeout(200)
    const stayed = (await session.page.locator('.delete-modal').count()) === 1
    const still = (await session.page.locator('.tree a.it', { hasText: title }).count()) === 1
    line('cancel_closed', closed)
    line('remains', remains)
    line('confirm_stayed', stayed)
    line('still', still)
    return remains && stayed && still
  } finally {
    await session.close()
  }
}

async function fc13(app: App, root: string) {
  const session = await browserSession(app, root)
  try {
    const made = await app.createPage(session.account.user.id, {
      spaceId: session.account.space.id,
      title: 'Heights',
    })
    await app.setPageLock(session.account.user.id, made.id, true)
    await session.page.goto(`${session.base}/s/${session.account.space.id}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await session.page.locator('.lock-chip').waitFor()
    const edit = session.page.locator('.mode-switch button', { hasText: 'Edit' })
    await edit.waitFor()
    await waitHydrated(session.page, '.mode-switch button')
    await edit.click()
    await session.page.locator('.mode-done').waitFor()
    const measured = await session.page.evaluate<{
      chip: number
      mode: number
      done: number
      top: boolean
      bottom: boolean
    } | null>(`(() => {
      const chip = document.querySelector('.lock-chip') && document.querySelector('.lock-chip').getBoundingClientRect()
      const mode = document.querySelector('.mode-switch') && document.querySelector('.mode-switch').getBoundingClientRect()
      const done = document.querySelector('.mode-done') && document.querySelector('.mode-done').getBoundingClientRect()
      if (!chip || !mode || !done) return null
      return {
        chip: Math.round(chip.height),
        mode: Math.round(mode.height),
        done: Math.round(done.height),
        top: Math.round(chip.top) === Math.round(mode.top) && Math.round(mode.top) === Math.round(done.top),
        bottom: Math.round(chip.bottom) === Math.round(mode.bottom) && Math.round(mode.bottom) === Math.round(done.bottom),
      }
    })()`)
    line('chip', measured?.chip ?? 0)
    line('mode', measured?.mode ?? 0)
    line('done', measured?.done ?? 0)
    line('aligned', Boolean(measured?.top && measured.bottom))
    return (
      measured?.chip === 36 &&
      measured.mode === 36 &&
      measured.done === 36 &&
      measured.top &&
      measured.bottom
    )
  } finally {
    await session.close()
  }
}

async function fc14(app: App, root: string) {
  const session = await browserSession(app, root)
  try {
    const made = await app.createPage(session.account.user.id, {
      spaceId: session.account.space.id,
      title: 'Readonly',
    })
    await session.page.goto(`${session.base}/s/${session.account.space.id}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await session.page.waitForSelector('.doc-editor')
    await session.page
      .waitForFunction(() => document.querySelector('.doc-editor')?.getAttribute('contenteditable') === 'false')
      .catch(() => undefined)
    const attrs = await session.page.locator('.doc-editor').evaluate((node) => ({
      editable: node.getAttribute('contenteditable'),
      readonly: node.getAttribute('aria-readonly'),
    }))
    line('contenteditable', attrs.editable ?? 'missing')
    line('aria_readonly', attrs.readonly ?? 'missing')
    return attrs.editable === 'false' && attrs.readonly === 'true'
  } finally {
    await session.close()
  }
}

async function fc15(app: App, root: string) {
  const session = await browserSession(app, root)
  try {
    const title = `Named ${Date.now()}`
    await session.page.goto(`${session.base}/s/${session.account.space.id}`, { waitUntil: 'domcontentloaded' })
    await waitHydrated(session.page, '.tree .new-page button')
    await session.page.locator('.tree').getByRole('button', { name: '+ New page' }).click()
    await session.page.locator('.tree .menu').getByRole('button', { name: 'Page', exact: true }).click()
    await session.page.locator('#page-title').waitFor()
    await waitHydrated(session.page, '#page-title')
    let stalled = 0
    await session.page.route(/_serverFn/, async (route) => {
      const body = route.request().postData() ?? ''
      if (!body.includes(title)) {
        stalled += 1
        await new Promise((resolve) => setTimeout(resolve, 900))
      }
      await route.continue()
    })
    const save = session.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && (response.request().postData() ?? '').includes(title),
    )
    await session.page.locator('#page-title').fill(title)
    await session.page.locator('#page-title').blur()
    await save
    const started = Date.now()
    await session.page.getByText('Saved', { exact: true }).waitFor({ timeout: 8000 })
    const savedDelay = Date.now() - started
    const crumb = (await session.page.locator('.crumbs b').innerText().catch(() => '')).trim()
    const row = await session.page.locator('.tree a.it', { hasText: title }).count()
    line('delay', savedDelay)
    line('stalled', stalled)
    line('crumb', crumb === title)
    line('sidebar', row > 0)
    return savedDelay >= 700 && crumb === title && row > 0
  } finally {
    await session.close()
  }
}

async function fc16(app: App, root: string) {
  const session = await browserSession(app, root)
  try {
    const title = `Gone ${Date.now()}`
    const made = await app.createPage(session.account.user.id, {
      spaceId: session.account.space.id,
      title,
    })
    await session.page.goto(`${session.base}/s/${session.account.space.id}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await session.page.locator('.tree a.it', { hasText: title }).waitFor()
    await session.page.evaluate(`(() => {
      const expected = ${JSON.stringify(title)}
      const pageId = ${JSON.stringify(made.id)}
      const target = window
      target.__snap = null
      const grab = () => {
        if (target.__snap) return
        const toast = document.querySelector('.toast')
        if (!toast || !toast.textContent || toast.textContent.indexOf('Page deleted.') < 0) return
        const rows = Array.from(document.querySelectorAll('.tree a.it')).filter((node) =>
          (node.textContent || '').indexOf(expected) >= 0,
        ).length
        target.__snap = { rows, onPage: location.pathname.indexOf(pageId) >= 0 }
      }
      new MutationObserver(grab).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    })()`)
    await openPageMenu(session.page)
    await session.page.locator('.delete-actions .btn.danger').click()
    await session.page.waitForFunction('window.__snap != null')
    const snap = await session.page.evaluate<{
      rows: number
      onPage: boolean
    } | null>('window.__snap')
    line('rows', snap?.rows ?? -1)
    line('on_page', Boolean(snap?.onPage))
    return snap?.rows === 0 && snap.onPage === false
  } finally {
    await session.close()
  }
}

async function cleanup() {
  if (stopping) return
  stopping = true
  for (const child of children) await stopChild(child).catch(() => undefined)
  if (pgName) await runFile('docker', ['rm', '-f', pgName]).catch(() => undefined)
  if (pgEnv) rmSync(pgEnv, { force: true })
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
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

const checks: Record<string, (app: App, root: string) => Promise<boolean>> = {
  fc1,
  fc2,
  fc3,
  fc4,
  fc5,
  fc6,
  fc7,
  fc8,
  fc9: async () => fc9(),
  fc10,
  fc11,
  fc12,
  fc13,
  fc14,
  fc15,
  fc16,
  fc18,
}

async function main() {
  const check = checks[id]
  if (!check) throw new Error('unknown step')
  const pin = id === 'fc18' ? FC18_PIN : PIN
  const sha = planted ? pin : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  line('sha', sha)
  const needsDb = !['fc5', 'fc9', 'fc10'].includes(id)
  if (needsDb) {
    await ensureDatabase()
    ensureAuth()
    await migrate()
  }
  const root = planted && (needsDb || id === 'fc5') ? await materialize(pin) : repoRoot
  const app: App | null = needsDb ? await loadApp(root) : null
  try {
    const fixed = await check(app ?? (null as unknown as App), root)
    if (app) await app.closeDb().catch(() => undefined)
    await cleanup()
    process.exit(fixed ? 0 : 1)
  } catch (error) {
    if (app) await app.closeDb().catch(() => undefined)
    throw error
  }
}

main().catch(async (error: unknown) => {
  line('error', 1)
  console.error(redact(error instanceof Error ? error.message : 'failed'))
  await cleanup()
  process.exit(2)
})
