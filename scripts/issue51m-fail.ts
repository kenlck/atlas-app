import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import postgres from 'postgres'
import { editedByLine } from '../src/lib/relative-time.ts'
import { stopChild } from './stop-child.ts'
import { assertLocalDatabaseUrl, submitAuthForm } from './verify-local.ts'

const PIN = '5158c5a07f01059d6224ece00e46c696a3e0d85d'
const repoRoot = join(import.meta.dirname, '..')
const arg = process.argv[2] ?? ''
const planted = arg.endsWith('-planted')
const id = planted ? arg.slice(0, -'-planted'.length) : arg
const side = planted ? 'planted' : 'head'

type View = {
  id: string
  title: string
  updatedAt: string
  updatedByName?: string
  lastEditedAt?: string | null
  lastEditedByName?: string | null
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
  getPageView: (userId: string, pageId: string) => Promise<View>
  movePage: (userId: string, input: Record<string, unknown>) => Promise<View>
  setPageLock: (userId: string, pageId: string, locked: boolean) => Promise<View>
  refreshDocText: (userId: string, pageId: string, tokenId: string | null) => Promise<void>
  updatePageForToken: (
    userId: string,
    tokenId: string,
    input: { pageId: string; body?: unknown; updatedAt: unknown },
  ) => Promise<View>
  createUser: (name?: string) => Promise<Account>
  closeDb: () => Promise<void>
  createApiToken: (
    userId: string,
    input: { name: string; scope: string },
  ) => Promise<{ id: string; token: string }>
  createTeam: (userId: string, name: string) => Promise<{ id: string; spaceId: string }>
  createInvite: (
    actorId: string,
    teamId: string,
    inviteeUserId: string,
  ) => Promise<{ id: string }>
  acceptInvite: (userId: string, inviteId: string) => Promise<unknown>
  removeMember: (actorId: string, teamId: string, memberUserId: string) => Promise<unknown>
  deleteTeam: (actorId: string, teamId: string) => Promise<unknown>
  searchVisiblePages: (userId: string, query: string) => Promise<Array<{ id: string }>>
}

type Stamp = {
  last_edited_at: Date | null
  last_edited_by: string | null
  updated_at: Date
  updated_by: string
}

const secrets: string[] = []
const children: Array<ReturnType<typeof spawn>> = []
const temps: string[] = []
let pgName = ''
let pgEnv = ''
let stopping = false

function line(key: string, value: string | number | boolean) {
  console.log(`51m_${id}_${side}_${key}=${value}`)
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
  pgEnv = join(tmpdir(), `atlas-51m-${process.pid}.env`)
  writeFileSync(pgEnv, `POSTGRES_USER=atlas\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=atlas\n`, {
    mode: 0o600,
  })
  pgName = `atlas-51m-pg-${process.pid}`
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
    process.env.BETTER_AUTH_SECRET = 'issue51m-fail-secret-not-a-credential'
  }
  remember(process.env.BETTER_AUTH_SECRET)
  if (!process.env.ADMIN_API_SECRET || process.env.ADMIN_API_SECRET.length < 32) {
    process.env.ADMIN_API_SECRET = 'issue51m-fail-admin-not-a-credential'
  }
  remember(process.env.ADMIN_API_SECRET)
  process.env.BETTER_AUTH_URL = base
  process.env.BETTER_AUTH_TELEMETRY = '0'
}

async function migrate() {
  await runFile('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'])
}

function materialize(sha: string) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-51m-'))
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

async function loadApp(root: string): Promise<App> {
  const href = (rel: string) => pathToFileURL(join(root, rel)).href
  const pages = (await import(href('src/lib/pages.ts'))) as App
  const helpers = (await import(href('tests/helpers.ts'))) as Pick<App, 'createUser'>
  const db = (await import(href('src/lib/db.ts'))) as Pick<App, 'closeDb'>
  const tokens = (await import(href('src/lib/api-tokens.ts'))) as Pick<App, 'createApiToken'>
  const teams = (await import(href('src/lib/teams.ts'))) as Pick<
    App,
    'createTeam' | 'createInvite' | 'acceptInvite' | 'removeMember' | 'deleteTeam'
  >
  const search = (await import(href('src/lib/search.ts'))) as Pick<App, 'searchVisiblePages'>
  return {
    createPage: pages.createPage,
    savePage: pages.savePage,
    getPageView: pages.getPageView,
    movePage: pages.movePage,
    setPageLock: pages.setPageLock,
    refreshDocText: pages.refreshDocText,
    updatePageForToken: pages.updatePageForToken,
    createUser: helpers.createUser,
    closeDb: db.closeDb,
    createApiToken: tokens.createApiToken,
    createTeam: teams.createTeam,
    createInvite: teams.createInvite,
    acceptInvite: teams.acceptInvite,
    removeMember: teams.removeMember,
    deleteTeam: teams.deleteTeam,
    searchVisiblePages: search.searchVisiblePages,
  }
}

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>) {
  const url = assertLocalDatabaseUrl(process.env.DATABASE_URL || '')
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function readStamp(pageId: string) {
  const rows = await withSql(
    (sql) => sql<Stamp[]>`
      select last_edited_at, last_edited_by, updated_at, updated_by
      from page where id = ${pageId}
    `,
  )
  const row = rows[0]
  if (!row) throw new Error('missing page')
  return row
}

function sameStamp(left: Stamp, right: Stamp) {
  return (
    left.last_edited_by === right.last_edited_by &&
    left.updated_by === right.updated_by &&
    left.updated_at.getTime() === right.updated_at.getTime() &&
    (left.last_edited_at?.getTime() ?? null) === (right.last_edited_at?.getTime() ?? null)
  )
}

function shownLine(view: View, now: Date) {
  if (Object.prototype.hasOwnProperty.call(view, 'lastEditedAt')) {
    return editedByLine(view.lastEditedByName ?? null, view.lastEditedAt ?? view.updatedAt, now)
  }
  return editedByLine(view.updatedByName ?? '', view.updatedAt, now)
}

async function userName(userId: string) {
  const rows = await withSql(
    (sql) => sql<Array<{ name: string }>>`select name from "user" where id = ${userId}`,
  )
  return rows[0]?.name ?? ''
}

async function teamWith(app: App, owner: Account, member: Account) {
  const team = await app.createTeam(owner.user.id, `Edit ${crypto.randomUUID().slice(0, 8)}`)
  const invite = await app.createInvite(owner.user.id, team.id, member.user.id)
  await app.acceptInvite(member.user.id, invite.id)
  return team
}

async function fc1(app: App) {
  const ada = await app.createUser('Ada Diagram')
  const bea = await app.createUser('Bea Diagram')
  remember(ada.password)
  remember(bea.password)
  const team = await teamWith(app, ada, bea)
  const token = `diag-${crypto.randomUUID().slice(0, 8)}`
  const target = await app.createPage(ada.user.id, {
    spaceId: team.spaceId,
    title: `${token} target`,
  })
  const older = await app.createPage(ada.user.id, {
    spaceId: team.spaceId,
    title: `${token} older`,
  })
  const oldAt = new Date('2020-01-01T00:00:00Z')
  const newAt = new Date('2024-06-01T00:00:00Z')
  await withSql(async (sql) => {
    await sql`
      update page
      set updated_at = ${oldAt}, last_edited_at = ${oldAt},
          updated_by = ${ada.user.id}, last_edited_by = ${ada.user.id}
      where id = ${target.id}
    `
    await sql`
      update page
      set updated_at = ${newAt}, last_edited_at = ${newAt},
          updated_by = ${ada.user.id}, last_edited_by = ${ada.user.id}
      where id = ${older.id}
    `
  })
  const opened = await app.getPageView(ada.user.id, target.id)
  await app.refreshDocText(bea.user.id, target.id, null)
  const after = await readStamp(target.id)
  const hits = await app.searchVisiblePages(ada.user.id, token)
  const view = await app.getPageView(ada.user.id, target.id)
  const meta = shownLine(view, new Date())
  const text = await attempt(() =>
    app.savePage(ada.user.id, {
      pageId: target.id,
      title: target.title,
      body: doc(`kept-after-diagram ${token}`),
      updatedAt: opened.updatedAt,
    }),
  )
  const storedView = await app.getPageView(ada.user.id, target.id)
  const stored = JSON.stringify(storedView.body).includes(`kept-after-diagram ${token}`)
  const rank = hits[0]?.id === target.id
  const editor = meta.includes(`Edited by ${bea.user.name}`)
  const stamp = after.updated_at.toISOString() === opened.updatedAt
  line('rank_target', rank)
  line('line_editor', editor)
  line('text', text)
  line('stored', stored)
  line('stamp', stamp)
  return rank && editor && text === 200 && stored && stamp
}

async function bootDev(root: string) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  ensureAuth(base)
  const child = spawn(
    'pnpm',
    ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BETTER_AUTH_URL: base },
      stdio: 'ignore',
    },
  )
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

async function enterEdit(page: Page) {
  await page.locator('.doc-editor').waitFor()
  await page.locator('.doc-editor[contenteditable="false"]').waitFor()
  const edit = page.locator('.mode-switch').getByRole('radio', { name: 'Edit', exact: true })
  if ((await edit.getAttribute('aria-checked')) !== 'true') await edit.click()
  await page.locator('.top.is-editing').waitFor()
  await page.locator('.doc-editor[contenteditable="true"]').waitFor()
}

async function typeSave(page: Page, marker: string) {
  const seen = page.waitForResponse((response) => {
    const request = response.request()
    if (request.method() !== 'POST') return false
    return (request.postData() ?? '').includes(marker)
  })
  await page.locator('.doc-editor').click()
  await page.keyboard.type(marker)
  await page.waitForFunction(
    (needle) => (document.querySelector('.doc-editor')?.textContent ?? '').includes(needle),
    marker,
  )
  const response = await seen
  return response.status()
}

async function fc2(app: App, root: string) {
  const ada = await app.createUser('Ada Token')
  const bea = await app.createUser('Bea Token')
  remember(ada.password)
  remember(bea.password)
  const made = await app.createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: 'Token note',
  })
  await app.savePage(ada.user.id, {
    pageId: made.id,
    title: 'Token note',
    body: doc('base'),
    updatedAt: made.updatedAt,
  })
  const token = await app.createApiToken(ada.user.id, { name: 'agent', scope: 'read_write' })
  remember(token.token)
  const base = await bootDev(root)
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(20000)
  try {
    await signIn(page, base, ada)
    await page.goto(`${base}/s/${ada.space.id}/p/${made.id}`, { waitUntil: 'domcontentloaded' })
    await page.locator('#page-title').waitFor()
    await enterEdit(page)
    const editor = await typeSave(page, 'm2open')
    const current = await app.getPageView(ada.user.id, made.id)
    const oldAt = new Date('2020-01-01T00:00:00Z')
    await withSql(
      (sql) => sql`
        update page
        set last_edited_at = ${oldAt}, last_edited_by = ${bea.user.id}
        where id = ${made.id}
      `,
    )
    await app.updatePageForToken(ada.user.id, token.id, {
      pageId: made.id,
      body: doc('from the token owner'),
      updatedAt: current.updatedAt,
    })
    const after = await readStamp(made.id)
    const owner = after.last_edited_by === ada.user.id
    const moved = (after.last_edited_at?.getTime() ?? 0) > oldAt.getTime()
    const stale = await typeSave(page, 'm2stale')
    line('editor', editor)
    line('owner', owner)
    line('moved', moved)
    line('stale', stale)
    return editor === 200 && owner && moved && stale === 409
  } finally {
    await browser.close()
  }
}

async function fc3(app: App) {
  const ada = await app.createUser('Ada Move')
  const bea = await app.createUser('Bea Move')
  remember(ada.password)
  remember(bea.password)
  const token = `park-${crypto.randomUUID().slice(0, 8)}`
  const parent = await app.createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: 'Folder',
  })
  const child = await app.createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: `${token} child`,
  })
  const other = await app.createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: `${token} other`,
  })
  await withSql(async (sql) => {
    await sql`
      update page
      set updated_at = ${new Date('2020-01-01T00:00:00Z')},
          last_edited_at = ${new Date('2024-06-01T00:00:00Z')},
          updated_by = ${ada.user.id},
          last_edited_by = ${bea.user.id}
      where id = ${child.id}
    `
    await sql`
      update page
      set updated_at = ${new Date('2024-06-01T00:00:00Z')},
          last_edited_at = ${new Date('2020-01-01T00:00:00Z')},
          updated_by = ${ada.user.id},
          last_edited_by = ${ada.user.id}
      where id = ${other.id}
    `
  })
  const before = await readStamp(child.id)
  const beforeHits = await app.searchVisiblePages(ada.user.id, token)
  const beforeView = await app.getPageView(ada.user.id, child.id)
  await app.movePage(ada.user.id, { pageId: child.id, parentId: parent.id })
  await app.setPageLock(ada.user.id, child.id, true)
  await app.setPageLock(ada.user.id, child.id, false)
  const after = await readStamp(child.id)
  const afterHits = await app.searchVisiblePages(ada.user.id, token)
  const afterView = await app.getPageView(ada.user.id, child.id)
  const now = new Date()
  const unchanged =
    sameStamp(before, after) &&
    beforeHits.map((hit) => hit.id).join() === afterHits.map((hit) => hit.id).join() &&
    shownLine(beforeView, now) === shownLine(afterView, now)
  const follows =
    beforeHits[0]?.id === child.id &&
    afterHits[0]?.id === child.id &&
    shownLine(afterView, now).includes(`Edited by ${bea.user.name}`)
  line('unchanged', unchanged)
  line('follows', follows)
  return unchanged && follows
}

async function fc4(app: App) {
  const ada = await app.createUser('Ada Backfill')
  const bea = await app.createUser('Bea Backfill')
  remember(ada.password)
  remember(bea.password)
  const token = `fill-${crypto.randomUUID().slice(0, 8)}`
  const first = await app.createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: `${token} first`,
  })
  const second = await app.createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: `${token} second`,
  })
  await withSql(
    (sql) => sql`
      update page
      set last_edited_at = updated_at, last_edited_by = updated_by
      where id = ${first.id} or id = ${second.id}
    `,
  )
  const now = new Date('2026-03-01T00:00:00Z')
  const legacy = async (pageId: string) => {
    const row = await readStamp(pageId)
    const name = await userName(row.updated_by)
    return editedByLine(name, row.updated_at.toISOString(), now)
  }
  const firstView = await app.getPageView(ada.user.id, first.id)
  const secondView = await app.getPageView(ada.user.id, second.id)
  const backfillLine =
    shownLine(firstView, now) === (await legacy(first.id)) &&
    shownLine(secondView, now) === (await legacy(second.id))
  const hits = await app.searchVisiblePages(ada.user.id, token)
  const rows = await withSql(
    (sql) => sql<Array<{ id: string; updated_at: Date }>>`
      select id, updated_at from page
      where id = ${first.id} or id = ${second.id}
      order by updated_at desc
    `,
  )
  const backfillOrder = hits.map((hit) => hit.id).join() === rows.map((row) => row.id).join()
  await withSql(async (sql) => {
    await sql`
      update page
      set updated_at = ${new Date('2020-01-01T00:00:00Z')},
          last_edited_at = ${new Date('2024-06-01T00:00:00Z')},
          last_edited_by = ${bea.user.id}
      where id = ${first.id}
    `
    await sql`
      update page
      set updated_at = ${new Date('2024-06-01T00:00:00Z')},
          last_edited_at = ${new Date('2020-01-01T00:00:00Z')},
          last_edited_by = ${ada.user.id}
      where id = ${second.id}
    `
  })
  const diverged = await app.searchVisiblePages(ada.user.id, token)
  const divergedView = await app.getPageView(ada.user.id, first.id)
  const follows =
    diverged[0]?.id === first.id &&
    shownLine(divergedView, now).includes(`Edited by ${bea.user.name}`)
  line('backfill_line', backfillLine)
  line('backfill_order', backfillOrder)
  line('follows', follows)
  return backfillLine && backfillOrder && follows
}

function noName(text: string) {
  return /^Edited (?!by\b)/.test(text.trim()) && !/\bby\b/.test(text)
}

async function fc5(app: App, root: string) {
  const ada = await app.createUser('Ada Delete')
  const bea = await app.createUser('Bea Delete')
  remember(ada.password)
  remember(bea.password)
  const team = await teamWith(app, ada, bea)
  const made = await app.createPage(ada.user.id, {
    spaceId: team.spaceId,
    title: 'Survives',
  })
  await app.refreshDocText(bea.user.id, made.id, null)
  const before = await readStamp(made.id)
  await app.removeMember(ada.user.id, team.id, bea.user.id)
  const afterRemove = await readStamp(made.id)
  const membership = sameStamp(before, afterRemove)
  let userDelete = false
  try {
    await withSql((sql) => sql`delete from "user" where id = ${bea.user.id}`)
    userDelete = true
  } catch (error) {
    line('user_delete_error', redact(error instanceof Error ? error.message : 'failed'))
  }
  const base = await bootDev(root)
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(20000)
  let meta = ''
  try {
    await signIn(page, base, ada)
    await page.goto(`${base}/s/${team.spaceId}/p/${made.id}`, { waitUntil: 'domcontentloaded' })
    meta = (await page.locator('.doc .meta').innerText()).trim()
  } finally {
    await browser.close()
  }
  let teamDelete = false
  try {
    await app.deleteTeam(ada.user.id, team.id)
    teamDelete = true
  } catch (error) {
    line('team_delete_error', redact(error instanceof Error ? error.message : 'failed'))
  }
  const cleared = noName(meta)
  line('membership', membership)
  line('user_delete', userDelete)
  line('team_delete', teamDelete)
  line('no_name', cleared)
  return membership && userDelete && teamDelete && cleared
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
}

async function main() {
  const check = checks[id]
  if (!check) throw new Error('unknown step')
  const sha = planted
    ? PIN
    : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  line('sha', sha)
  await ensureDatabase()
  ensureAuth()
  await migrate()
  const root = planted ? await materialize(PIN) : repoRoot
  const app = await loadApp(root)
  try {
    const fixed = await check(app, root)
    await app.closeDb().catch(() => undefined)
    await cleanup()
    process.exit(fixed ? 0 : 1)
  } catch (error) {
    await app.closeDb().catch(() => undefined)
    throw error
  }
}

main().catch(async (error: unknown) => {
  line('error', 1)
  console.error(redact(error instanceof Error ? error.message : 'failed'))
  await cleanup()
  process.exit(2)
})
