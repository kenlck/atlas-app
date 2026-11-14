import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { assertLocalBaseUrl, assertLocalDatabaseUrl, enterEdit, submitAuthForm } from './verify-local.ts'
import {
  archiveBlockedByLock,
  denyOwner,
  stuckAfterUnlock,
  uncheckedLock,
  unlockOnlyLocker,
  wrappingChipHtml,
} from './fixtures/issue38-lock.ts'

const PIN = 'e6902c30b015d608b5d26f68f9f196368864cd59'
const repoRoot = join(import.meta.dirname, '..')
const BASE = assertLocalBaseUrl(process.env.BASE_URL ?? 'http://127.0.0.1:3000')

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>

type Person = {
  user: { id: string; email: string; name?: string }
  password: string
  space: { id: string }
}

type App = {
  createPage: (
    userId: string,
    input: {
      spaceId: string
      parentId?: string | null
      title?: string
      kind?: 'doc' | 'whiteboard'
    },
  ) => Promise<{ id: string; title: string; updatedAt?: string }>
  savePage: (
    userId: string,
    input: { pageId: string; title: string; body: unknown },
  ) => Promise<{ title: string }>
  renamePage: (userId: string, input: { pageId: string; title: string }) => Promise<unknown>
  movePage: (
    userId: string,
    input: { pageId: string; parentId: string | null },
  ) => Promise<unknown>
  archivePage: (userId: string, pageId: string) => Promise<unknown>
  getPageView: (
    userId: string,
    pageId: string,
  ) => Promise<{ updatedAt: string; lockedByName?: string | null; canEdit?: boolean }>
  setPageLock?: (userId: string, pageId: string, locked: boolean) => Promise<unknown>
  createUser: (name?: string) => Promise<Person>
  createTeam: (userId: string, name: string) => Promise<{ id: string; spaceId: string }>
  createInvite: (
    actorId: string,
    teamId: string,
    inviteeUserId: string,
  ) => Promise<{ id: string }>
  acceptInvite: (userId: string, inviteId: string) => Promise<unknown>
  removeMember: (actorId: string, teamId: string, memberUserId: string) => Promise<unknown>
  createApiToken: (
    userId: string,
    input: { name?: string; scope?: string },
  ) => Promise<{ token: string }>
  handleMcp: (request: Request) => Promise<Response>
  handleDrawingRequest: (request: Request) => Promise<Response>
  getSql: () => Sql
  closeDb: () => Promise<void>
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

function line(name: string, value: string | number | boolean) {
  console.log(`${name}=${value}`)
}

function databaseUrl() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required')
  assertLocalDatabaseUrl(url)
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = url
}

function ensureAuthEnv() {
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    process.env.BETTER_AUTH_SECRET = 'issue38-fail-secret-not-a-credential'
  }
  if (!process.env.BETTER_AUTH_URL) process.env.BETTER_AUTH_URL = BASE
}

function pinText(path: string) {
  return execFileSync('git', ['show', `${PIN}:${path}`], { cwd: repoRoot, encoding: 'utf8' })
}

function materializePin() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-38-'))
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

async function loadApp(root: string): Promise<App> {
  const href = (rel: string) => pathToFileURL(join(root, rel)).href
  const pages = (await import(href('src/lib/pages.ts'))) as App
  const helpers = (await import(href('tests/helpers.ts'))) as Pick<App, 'createUser'>
  const teams = (await import(href('src/lib/teams.ts'))) as Pick<
    App,
    'createTeam' | 'createInvite' | 'acceptInvite' | 'removeMember'
  >
  const tokens = (await import(href('src/lib/api-tokens.ts'))) as Pick<App, 'createApiToken'>
  const mcp = (await import(href('src/lib/mcp.ts'))) as Pick<App, 'handleMcp'>
  const drawings = (await import(href('src/lib/drawing-request.ts'))) as Pick<
    App,
    'handleDrawingRequest'
  >
  const db = (await import(href('src/lib/db.ts'))) as Pick<App, 'closeDb' | 'getSql'>
  return {
    createPage: pages.createPage,
    savePage: pages.savePage,
    renamePage: pages.renamePage,
    movePage: pages.movePage,
    archivePage: pages.archivePage,
    getPageView: pages.getPageView,
    setPageLock: pages.setPageLock,
    createUser: helpers.createUser,
    createTeam: teams.createTeam,
    createInvite: teams.createInvite,
    acceptInvite: teams.acceptInvite,
    removeMember: teams.removeMember,
    createApiToken: tokens.createApiToken,
    handleMcp: mcp.handleMcp,
    handleDrawingRequest: drawings.handleDrawingRequest,
    getSql: db.getSql,
    closeDb: db.closeDb,
  }
}

async function statusOf(attempt: () => Promise<unknown>) {
  try {
    await attempt()
    return 200
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status?: unknown }).status
      if (typeof status === 'number') return status
    }
    return 500
  }
}

async function roster(app: App) {
  const owner = await app.createUser('Ada Owner')
  const member = await app.createUser('Bea Member')
  const other = await app.createUser('Dee Member')
  const outsider = await app.createUser('Cid Outsider')
  const created = await app.createTeam(owner.user.id, 'Lock Team')
  const memberInvite = await app.createInvite(owner.user.id, created.id, member.user.id)
  await app.acceptInvite(member.user.id, memberInvite.id)
  const otherInvite = await app.createInvite(owner.user.id, created.id, other.user.id)
  await app.acceptInvite(other.user.id, otherInvite.id)
  return { owner, member, other, outsider, teamId: created.id, spaceId: created.spaceId }
}

async function lockRow(sql: Sql, userId: string, pageId: string) {
  await sql`update page set locked_by = ${userId}, locked_at = now() where id = ${pageId}`
}

async function readRow(sql: Sql, pageId: string) {
  const rows = await sql`
    select title, body_text, parent_id, archived_at, locked_by, locked_at
    from page where id = ${pageId}
  `
  const row = rows[0]
  if (!row) throw new Error('missing page')
  return row
}

function sameLock(before: Record<string, unknown>, after: Record<string, unknown>) {
  return (
    before.locked_by === after.locked_by &&
    String(before.locked_at ?? '') === String(after.locked_at ?? '') &&
    before.title === after.title &&
    before.body_text === after.body_text &&
    String(before.parent_id ?? '') === String(after.parent_id ?? '') &&
    String(before.archived_at ?? '') === String(after.archived_at ?? '')
  )
}

async function browserPage(width = 1280) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 })
  return { browser, page }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const field = document.getElementById('email')
    if (!field) return false
    return Object.getOwnPropertyNames(field).some((key) => key.startsWith('__reactProps'))
  })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
  await page.waitForFunction(() => !location.pathname.startsWith('/sign-in'))
}

async function openPage(page: Page, spaceId: string, pageId: string) {
  await page.goto(`${BASE}/s/${spaceId}/p/${pageId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('#page-title').waitFor()
}

async function shot(page: Page, name: string) {
  const buf = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  for (const dir of [join(repoRoot, 'artifacts', sha), '/opt/cursor/artifacts']) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), buf)
  }
  line('screenshot', name)
}

async function waitHydrated(page: Page, selector: string) {
  await page.waitForFunction((target) => {
    const node = document.querySelector(target)
    if (!node) return false
    return Object.getOwnPropertyNames(node).some((key) => key.startsWith('__reactProps'))
  }, selector)
}

async function openHeaderMenu(page: Page) {
  const button = page.locator('.page-menu-btn')
  await button.waitFor()
  await waitHydrated(page, '.page-menu-btn')
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  await page.locator('.page-menu .menu').waitFor()
}

async function menuHasLock(page: Page) {
  await openHeaderMenu(page)
  const labels = await page.locator('.page-menu .menu button').allInnerTexts()
  return labels.some((label) => label.trim() === 'Lock' || label.trim() === 'Unlock')
}

async function openDrawer(page: Page) {
  const opener = page.getByRole('button', { name: 'Open pages' })
  if (await opener.isVisible()) await opener.click()
  await page.locator('.side').waitFor()
}

function watchSaves(page: Page) {
  let saves = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const url = request.url()
    const body = request.postData() ?? ''
    if (url.includes('/api/pages/save') || url.includes('/api/drawings')) {
      saves += 1
      return
    }
    if (
      (url.includes('_serverFn') || url.includes('serverFn')) &&
      body.includes('"pageId"') &&
      body.includes('"body"')
    ) {
      saves += 1
    }
  })
  return () => saves
}

async function scrollBox(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
}

async function chipWraps(page: Page) {
  return page.evaluate(() => {
    const span = document.querySelector('.lock-chip span')
    if (!span) return true
    const style = getComputedStyle(span)
    return style.whiteSpace !== 'nowrap' || span.getClientRects().length > 1
  })
}

async function fc1(app: App, planted: boolean) {
  const prefix = planted ? '38_fc1_planted' : '38_fc1_head'
  if (planted) {
    line(
      `${prefix}_note`,
      'e6902c30 has no page lock, so this planted case uses a fixture that locks without the creator or owner check',
    )
    const { other, spaceId } = await roster(app)
    const note = await app.createPage(other.user.id, { spaceId, title: 'Other note' })
    const result = await uncheckedLock(app.getSql(), other.user.id, note.id)
    line(`${prefix}_status`, result.status)
    line(`${prefix}_changed`, result.changed)
    return result.status === 200 && result.changed
  }
  const { owner, member, other, outsider, spaceId } = await roster(app)
  if (!app.setPageLock) throw new Error('setPageLock missing')
  const note = await app.createPage(member.user.id, { spaceId, title: 'Member note' })
  const parent = await app.createPage(owner.user.id, { spaceId, title: 'Gone parent' })
  const child = await app.createPage(owner.user.id, {
    spaceId,
    parentId: parent.id,
    title: 'Gone child',
  })
  await app.setPageLock(owner.user.id, note.id, true)
  const held = await readRow(app.getSql(), note.id)
  const memberStatus = await statusOf(() => app.setPageLock!(other.user.id, note.id, false))
  const afterMember = await readRow(app.getSql(), note.id)
  const outsiderStatus = await statusOf(() => app.setPageLock!(outsider.user.id, note.id, false))
  await app.archivePage(owner.user.id, parent.id)
  const deletedStatus = await statusOf(() => app.setPageLock!(owner.user.id, parent.id, true))
  const childStatus = await statusOf(() => app.setPageLock!(owner.user.id, child.id, true))
  const childRow = await readRow(app.getSql(), child.id)
  const unchanged = sameLock(held, afterMember) && childRow.locked_at == null
  line(`${prefix}_member_status`, memberStatus)
  line(`${prefix}_outsider_status`, outsiderStatus)
  line(`${prefix}_deleted_status`, deletedStatus)
  line(`${prefix}_child_status`, childStatus)
  line(`${prefix}_unchanged`, unchanged)

  const menuPage = await app.createPage(member.user.id, { spaceId, title: 'Menu note' })
  const creatorBrowser = await browserPage()
  let creatorMenu = false
  let memberMenu = true
  try {
    await signIn(creatorBrowser.page, member.user.email, member.password)
    await openPage(creatorBrowser.page, spaceId, menuPage.id)
    creatorMenu = await menuHasLock(creatorBrowser.page)
    await shot(creatorBrowser.page, 'lock-menu-1280.png')
    await creatorBrowser.page.setViewportSize({ width: 390, height: 800 })
    await openHeaderMenu(creatorBrowser.page)
    await shot(creatorBrowser.page, 'lock-menu-390.png')
  } finally {
    await creatorBrowser.browser.close()
  }
  const memberBrowser = await browserPage()
  try {
    await signIn(memberBrowser.page, other.user.email, other.password)
    await openPage(memberBrowser.page, spaceId, note.id)
    memberMenu = await menuHasLock(memberBrowser.page)
  } finally {
    await memberBrowser.browser.close()
  }
  line(`${prefix}_member_menu`, memberMenu)
  line(`${prefix}_creator_menu`, creatorMenu)
  return !(
    memberStatus === 403 &&
    outsiderStatus === 404 &&
    deletedStatus === 404 &&
    childStatus === 404 &&
    unchanged &&
    memberMenu === false &&
    creatorMenu === true
  )
}

async function fc2(app: App, planted: boolean) {
  const prefix = planted ? '38_fc2_planted' : '38_fc2_head'
  const { owner, member, spaceId } = await roster(app)
  const note = await app.createPage(member.user.id, { spaceId, title: 'Locked note' })
  await lockRow(app.getSql(), owner.user.id, note.id)
  if (planted) {
    const modeBar = pinText('src/components/PageModeBar.tsx')
    const status = await statusOf(() =>
      app.savePage(member.user.id, {
        pageId: note.id,
        title: 'Planted save',
        body: doc('planted'),
      }),
    )
    line(`${prefix}_save_status`, status)
    line(`${prefix}_chip`, modeBar.includes('lock-chip'))
    line(`${prefix}_switch`, modeBar.includes('mode-switch') && !modeBar.includes('lockedView'))
    return status === 200 && !modeBar.includes('lock-chip')
  }
  const before = await readRow(app.getSql(), note.id)
  const browser = await browserPage()
  const saves = watchSaves(browser.page)
  try {
    await signIn(browser.page, member.user.email, member.password)
    await openPage(browser.page, spaceId, note.id)
    await browser.page.locator('.doc-editor[contenteditable="false"]').waitFor()
    const chip = (await browser.page.locator('.lock-chip').innerText()).includes('Locked by Ada Owner')
    const icon = (await browser.page.locator('.tree [aria-label="Locked"]').count()) > 0
    const switcher = await browser.page.locator('.mode-switch').count()
    const iconButton = await browser.page.locator('.mode-icon').count()
    await browser.page.locator('.doc-editor').click({ force: true })
    await browser.page.keyboard.type('should not stick')
    await browser.page.waitForTimeout(1000)
    const editorText = await browser.page.locator('.doc-editor').innerText()
    const titleReadOnly = await browser.page.locator('#page-title').getAttribute('readonly')
    const editable = await browser.page.locator('.doc-editor').getAttribute('contenteditable')
    await shot(browser.page, 'lock-member-1280.png')
    await browser.page.setViewportSize({ width: 390, height: 800 })
    await browser.page.locator('.lock-chip').waitFor()
    await shot(browser.page, 'lock-member-390.png')
    await openDrawer(browser.page)
    const iconNarrow = (await browser.page.locator('.tree [aria-label="Locked"]').count()) > 0
    await shot(browser.page, 'lock-member-390-sidebar.png')
    const after = await readRow(app.getSql(), note.id)
    const child = await statusOf(() =>
      app.createPage(member.user.id, { spaceId, parentId: note.id, title: 'Child of locked' }),
    )
    const readonly = titleReadOnly !== null && editable === 'false' && !editorText.includes('should not stick')
    line(`${prefix}_chip`, chip)
    line(`${prefix}_icon`, icon && iconNarrow)
    line(`${prefix}_switch`, switcher > 0 || iconButton > 0)
    line(`${prefix}_readonly`, readonly)
    line(`${prefix}_saves`, saves())
    line(`${prefix}_stored`, after.title !== before.title || after.body_text !== before.body_text)
    line(`${prefix}_child_status`, child)
    return !(
      chip &&
      icon &&
      iconNarrow &&
      switcher === 0 &&
      iconButton === 0 &&
      readonly &&
      saves() === 0 &&
      after.body_text === before.body_text &&
      child === 200
    )
  } finally {
    await browser.browser.close()
  }
}

const sceneBody = {
  pageId: '',
  version: 1,
  elements: [{ id: 'box', type: 'rectangle', x: 1, y: 2 }],
  appState: {},
  files: {},
}

async function postDrawing(app: App, token: string, pageId: string) {
  const response = await app.handleDrawingRequest(
    new Request('http://127.0.0.1/api/drawings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...sceneBody, pageId }),
    }),
  )
  return response.status
}

async function postMcp(app: App, token: string, pageId: string, updatedAt: string, title: string) {
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
        params: {
          name: 'update_page',
          arguments: { page_id: pageId, title, updated_at: updatedAt },
        },
      }),
    }),
  )
  const body = (await response.json()) as { error?: { message?: string } }
  return { status: response.status, message: body.error?.message ?? '' }
}

async function fc3(app: App, planted: boolean) {
  const prefix = planted ? '38_fc3_planted' : '38_fc3_head'
  const { owner, member, other, spaceId } = await roster(app)
  const saveTarget = await app.createPage(member.user.id, { spaceId, title: 'Save me' })
  const renameTarget = await app.createPage(member.user.id, { spaceId, title: 'Rename me' })
  const moveTarget = await app.createPage(member.user.id, { spaceId, title: 'Move me' })
  const parent = await app.createPage(member.user.id, { spaceId, title: 'Move parent' })
  const archiveTarget = await app.createPage(member.user.id, { spaceId, title: 'Archive me' })
  const mcpTarget = await app.createPage(member.user.id, { spaceId, title: 'Token me' })
  const board = await app.createPage(member.user.id, {
    spaceId,
    title: 'Board me',
    kind: 'whiteboard',
  })
  for (const pageId of [saveTarget.id, renameTarget.id, moveTarget.id, archiveTarget.id, mcpTarget.id, board.id]) {
    await lockRow(app.getSql(), owner.user.id, pageId)
  }
  const before = await readRow(app.getSql(), saveTarget.id)
  const token = await app.createApiToken(member.user.id, { name: 'lock', scope: 'read_write' })
  const current = await app.getPageView(owner.user.id, mcpTarget.id)
  const saveStatus = await statusOf(() =>
    app.savePage(member.user.id, { pageId: saveTarget.id, title: 'Saved', body: doc('secret') }),
  )
  const renameStatus = await statusOf(() =>
    app.renamePage(member.user.id, { pageId: renameTarget.id, title: 'Renamed' }),
  )
  const moveStatus = await statusOf(() =>
    app.movePage(member.user.id, { pageId: moveTarget.id, parentId: parent.id }),
  )
  const archiveStatus = await statusOf(() => app.archivePage(other.user.id, archiveTarget.id))
  const drawingStatus = await postDrawing(app, token.token, board.id)
  const mcp = await postMcp(app, token.token, mcpTarget.id, current.updatedAt, 'From token')
  const after = await readRow(app.getSql(), saveTarget.id)
  const renamed = await readRow(app.getSql(), renameTarget.id)
  const moved = await readRow(app.getSql(), moveTarget.id)
  const archived = await readRow(app.getSql(), archiveTarget.id)
  const tokenRow = await readRow(app.getSql(), mcpTarget.id)
  const stored =
    after.title !== before.title ||
    String(after.body_text ?? '').includes('secret') ||
    renamed.title === 'Renamed' ||
    moved.parent_id != null ||
    archived.archived_at != null ||
    tokenRow.title === 'From token'
  line(`${prefix}_save_status`, saveStatus)
  line(`${prefix}_drawing_status`, drawingStatus)
  line(`${prefix}_rename_status`, renameStatus)
  line(`${prefix}_move_status`, moveStatus)
  line(`${prefix}_archive_status`, archiveStatus)
  line(`${prefix}_archive_archived`, archived.archived_at != null)
  line(`${prefix}_mcp_status`, mcp.status)
  line(`${prefix}_stored`, stored)
  line(`${prefix}_restore`, 'skipped')
  if (!planted) line(`${prefix}_message`, mcp.message)
  if (planted) {
    return (
      saveStatus === 200 &&
      drawingStatus === 200 &&
      renameStatus === 200 &&
      moveStatus === 200 &&
      archiveStatus === 403 &&
      archived.archived_at == null &&
      mcp.status === 200 &&
      stored
    )
  }
  return !(
    saveStatus === 423 &&
    drawingStatus === 423 &&
    renameStatus === 423 &&
    moveStatus === 423 &&
    archiveStatus === 403 &&
    archived.archived_at == null &&
    mcp.status === 423 &&
    mcp.message.startsWith('Page is locked by') &&
    !stored
  )
}

async function fc4(app: App, planted: boolean) {
  const prefix = planted ? '38_fc4_planted' : '38_fc4_head'
  const { owner, member, spaceId } = await roster(app)
  const note = await app.createPage(member.user.id, { spaceId, title: 'Owned' })
  await lockRow(app.getSql(), member.user.id, note.id)
  if (planted) {
    line(
      `${prefix}_note`,
      'e6902c30 has no page lock, so this planted case uses a fixture that denies the owner',
    )
    const result = await denyOwner(app.getSql(), note.id)
    line(`${prefix}_owner_save`, result.save)
    line(`${prefix}_owner_unlock`, result.unlock)
    return result.save === 423 && result.unlock === 403
  }
  if (!app.setPageLock) throw new Error('setPageLock missing')
  const creatorSave = await statusOf(() =>
    app.savePage(member.user.id, { pageId: note.id, title: 'Creator edit', body: doc('creator') }),
  )
  const ownerSave = await statusOf(() =>
    app.savePage(owner.user.id, { pageId: note.id, title: 'Owner edit', body: doc('owner') }),
  )
  const creatorUnlock = await statusOf(() => app.setPageLock!(member.user.id, note.id, false))
  await app.setPageLock(owner.user.id, note.id, true)
  const ownerUnlock = await statusOf(() => app.setPageLock!(owner.user.id, note.id, false))
  const personal = await app.createPage(owner.user.id, { spaceId: owner.space.id, title: 'Personal' })
  const personalLock = await statusOf(() => app.setPageLock!(owner.user.id, personal.id, true))
  line(`${prefix}_creator_save`, creatorSave)
  line(`${prefix}_owner_save`, ownerSave)
  line(`${prefix}_creator_unlock`, creatorUnlock)
  line(`${prefix}_owner_unlock`, ownerUnlock)
  line(`${prefix}_personal_lock`, personalLock)
  return !(
    creatorSave === 200 &&
    ownerSave === 200 &&
    creatorUnlock === 200 &&
    ownerUnlock === 200 &&
    personalLock === 200
  )
}

async function fc5(app: App, planted: boolean) {
  const prefix = planted ? '38_fc5_planted' : '38_fc5_head'
  const { owner, member, teamId, spaceId } = await roster(app)
  const note = await app.createPage(member.user.id, { spaceId, title: 'Left behind' })
  await lockRow(app.getSql(), member.user.id, note.id)
  if (planted) {
    line(
      `${prefix}_note`,
      'e6902c30 has no page lock, so this planted case uses a fixture that unlocks only the locker',
    )
    const status = await unlockOnlyLocker(app.getSql(), owner.user.id, note.id)
    line(`${prefix}_owner_unlock`, status)
    return status === 403
  }
  if (!app.setPageLock) throw new Error('setPageLock missing')
  await app.removeMember(owner.user.id, teamId, member.user.id)
  const creatorStatus = await statusOf(() => app.setPageLock!(member.user.id, note.id, false))
  const ownerUnlock = await statusOf(() => app.setPageLock!(owner.user.id, note.id, false))
  const row = await readRow(app.getSql(), note.id)
  line(`${prefix}_owner_unlock`, ownerUnlock)
  line(`${prefix}_locked`, row.locked_at != null)
  line(`${prefix}_creator_status`, creatorStatus)
  return !(ownerUnlock === 200 && row.locked_at == null && row.locked_by == null && creatorStatus === 404)
}

async function raceSave(
  app: App,
  ownerId: string,
  memberId: string,
  teamId: string,
  pageId: string,
) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const holder = postgres(url, { max: 1 })
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let sawWait = false
  const locking = holder.begin(async (tx) => {
    await tx`select user_id from team_member where team_id = ${teamId} and user_id = ${ownerId} for key share`
    await tx`select id from page where id = ${pageId} for update`
    release()
    const start = Date.now()
    while (Date.now() - start < 5000) {
      const waiting = await tx<
        { n: number }[]
      >`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid()`
      if (Number(waiting[0]?.n) > 0) {
        sawWait = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await tx`update page set locked_by = ${ownerId}, locked_at = now() where id = ${pageId}`
  })
  await held
  const status = await statusOf(() =>
    app.savePage(memberId, { pageId, title: 'Late', body: doc('late-marker') }),
  )
  await locking
  await holder.end({ timeout: 5 })
  const after = await readRow(app.getSql(), pageId)
  return {
    status,
    stored: after.title === 'Late' || String(after.body_text ?? '').includes('late-marker'),
    sawWait,
  }
}

async function fc6(app: App, planted: boolean) {
  const prefix = planted ? '38_fc6_planted' : '38_fc6_head'
  const { owner, member, teamId, spaceId } = await roster(app)
  const note = await app.createPage(member.user.id, { spaceId, title: 'Race' })
  const result = await raceSave(app, owner.user.id, member.user.id, teamId, note.id)
  line(`${prefix}_status`, result.status)
  line(`${prefix}_stored`, result.stored)
  line(`${prefix}_saw_wait`, result.sawWait)
  if (planted) return result.status === 200 && result.stored && result.sawWait
  return !(result.status === 423 && !result.stored && result.sawWait)
}

async function fc7(app: App, planted: boolean) {
  const prefix = planted ? '38_fc7_planted' : '38_fc7_head'
  if (planted) {
    const source = pinText('src/components/PageEditor.tsx')
    const banner = source.includes('locked this page')
    line(`${prefix}_banner`, banner)
    return !banner
  }
  if (!app.setPageLock) throw new Error('setPageLock missing')
  const { owner, member, spaceId } = await roster(app)
  const note = await app.createPage(member.user.id, { spaceId, title: 'Mid edit' })
  const marker = `unsaved-${crypto.randomUUID()}`
  const browser = await browserPage()
  let locked = false
  await browser.page.route('**/*', async (route) => {
    const request = route.request()
    if (!locked && request.method() === 'POST' && (request.postData() ?? '').includes(marker)) {
      locked = true
      await app.setPageLock!(owner.user.id, note.id, true)
    }
    await route.continue()
  })
  try {
    await signIn(browser.page, member.user.email, member.password)
    await openPage(browser.page, spaceId, note.id)
    await waitHydrated(browser.page, '.mode-switch button')
    await enterEdit(browser.page)
    await browser.page.locator('.doc-editor').click()
    await browser.page.keyboard.type(marker)
    await browser.page.locator('[role="alert"]').waitFor({ timeout: 8000 })
    const bannerText = await browser.page.locator('[role="alert"]').innerText()
    const editorText = await browser.page.locator('.doc-editor').innerText()
    const editable = await browser.page.locator('.doc-editor').getAttribute('contenteditable')
    const undo = await browser.page.getByRole('button', { name: 'Undo' }).count()
    const copy = await browser.page.getByRole('button', { name: 'Copy my changes' }).count()
    const row = await readRow(app.getSql(), note.id)
    await shot(browser.page, 'lock-banner-1280.png')
    await browser.page.setViewportSize({ width: 390, height: 800 })
    await shot(browser.page, 'lock-banner-390.png')
    const wanted = 'Ada Owner locked this page. Your last changes weren\'t saved.'
    line(`${prefix}_banner`, bannerText.includes('locked this page'))
    line(`${prefix}_text`, editorText.includes(marker) && bannerText.includes(wanted))
    line(`${prefix}_readonly`, editable === 'false')
    line(`${prefix}_stored`, String(row.body_text ?? '').includes(marker))
    line(`${prefix}_undo`, undo > 0)
    line(`${prefix}_copy`, copy > 0)
    return !(
      bannerText.includes(wanted) &&
      editorText.includes(marker) &&
      editable === 'false' &&
      !String(row.body_text ?? '').includes(marker) &&
      undo === 0 &&
      copy === 0
    )
  } finally {
    await browser.browser.close()
  }
}

async function fc8(app: App, planted: boolean) {
  const prefix = planted ? '38_fc8_planted' : '38_fc8_head'
  if (planted) {
    line(
      `${prefix}_note`,
      'e6902c30 always shows View and Edit, so this planted case uses a fixture that reports the page locked out of editing after unlock',
    )
    const result = stuckAfterUnlock()
    line(`${prefix}_can_edit`, result.canEdit)
    return result.canEdit === false
  }
  if (!app.setPageLock) throw new Error('setPageLock missing')
  const { owner, member, spaceId } = await roster(app)
  const note = await app.createPage(member.user.id, { spaceId, title: 'Unlock me' })
  await app.setPageLock(owner.user.id, note.id, true)
  await app.setPageLock(owner.user.id, note.id, false)
  const marker = `unlocked-${crypto.randomUUID()}`
  const browser = await browserPage()
  try {
    await signIn(browser.page, member.user.email, member.password)
    await openPage(browser.page, spaceId, note.id)
    await waitHydrated(browser.page, '.mode-switch button')
    const switcher = await browser.page.locator('.mode-switch').count()
    await enterEdit(browser.page)
    await browser.page.locator('.doc-editor').click()
    await browser.page.keyboard.type(marker)
    await browser.page.waitForTimeout(1200)
    const row = await readRow(app.getSql(), note.id)
    line(`${prefix}_switch`, switcher > 0)
    line(`${prefix}_saved`, String(row.body_text ?? '').includes(marker))
    return !(switcher > 0 && String(row.body_text ?? '').includes(marker))
  } finally {
    await browser.browser.close()
  }
}

async function sceneOf(sql: Sql, pageId: string) {
  const rows = await sql`select version, scene from drawing where page_id = ${pageId}`
  return JSON.stringify(rows[0] ?? null)
}

async function fc9(app: App, planted: boolean) {
  const prefix = planted ? '38_fc9_planted' : '38_fc9_head'
  const { owner, member, spaceId } = await roster(app)
  const board = await app.createPage(member.user.id, {
    spaceId,
    title: 'Locked board',
    kind: 'whiteboard',
  })
  await lockRow(app.getSql(), owner.user.id, board.id)
  const before = await sceneOf(app.getSql(), board.id)
  const token = await app.createApiToken(member.user.id, { name: 'board', scope: 'read_write' })
  if (planted) {
    const status = await postDrawing(app, token.token, board.id)
    line(`${prefix}_draw_status`, status)
    return status === 200
  }
  const status = await postDrawing(app, token.token, board.id)
  const after = await sceneOf(app.getSql(), board.id)
  const browser = await browserPage()
  let viewMode = false
  try {
    await signIn(browser.page, member.user.email, member.password)
    await openPage(browser.page, spaceId, board.id)
    await browser.page.locator('.excalidraw').waitFor({ timeout: 30_000 })
    viewMode = await browser.page.evaluate(
      () => document.querySelector('[class*="view-mode"]') != null,
    )
  } finally {
    await browser.browser.close()
  }
  line(`${prefix}_view_mode`, viewMode)
  line(`${prefix}_save_status`, status)
  line(`${prefix}_scene_same`, before === after)
  return !(viewMode && status === 423 && before === after)
}

async function fc10(app: App, planted: boolean) {
  const prefix = planted ? '38_fc10_planted' : '38_fc10_head'
  const browser = await browserPage(390)
  try {
    if (planted) {
      line(
        `${prefix}_note`,
        'e6902c30 has no lock chip, so this planted case uses a fixture page whose chip wraps',
      )
      await browser.page.setContent(wrappingChipHtml)
      const wraps = await chipWraps(browser.page)
      line(`${prefix}_wrap`, wraps)
      return wraps
    }
    if (!app.setPageLock) throw new Error('setPageLock missing')
    const { owner, member, spaceId } = await roster(app)
    const note = await app.createPage(member.user.id, { spaceId, title: 'Chip' })
    await app.setPageLock(owner.user.id, note.id, true)
    await signIn(browser.page, member.user.email, member.password)
    await openPage(browser.page, spaceId, note.id)
    await browser.page.locator('.lock-chip').waitFor()
    const narrowWrap = await chipWraps(browser.page)
    const narrow = await scrollBox(browser.page)
    await browser.page.setViewportSize({ width: 1280, height: 800 })
    const wide = await scrollBox(browser.page)
    line(`${prefix}_390_wrap`, narrowWrap)
    line(`${prefix}_390_scroll`, narrow.scrollWidth > narrow.innerWidth)
    line(`${prefix}_1280_scroll`, wide.scrollWidth > wide.innerWidth)
    return !(
      narrowWrap === false &&
      narrow.scrollWidth <= narrow.innerWidth &&
      wide.scrollWidth <= wide.innerWidth
    )
  } finally {
    await browser.browser.close()
  }
}

function hasStep(text: string, id: number) {
  return new RegExp(`38-fc${id}(?!\\d)`).test(text)
}

function fc11(planted: boolean) {
  const prefix = planted ? '38_fc11_planted' : '38_fc11_head'
  const verifyAll = planted
    ? pinText('scripts/verify-all.sh')
    : readFileSync(join(repoRoot, 'scripts/verify-all.sh'), 'utf8')
  const recipes = planted
    ? pinText('scripts/verify-fail-conditions.sh')
    : readFileSync(join(repoRoot, 'scripts/verify-fail-conditions.sh'), 'utf8')
  const missing = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].some(
    (id) => !hasStep(verifyAll, id) || !hasStep(recipes, id),
  )
  line(planted ? `${prefix}_missing` : `${prefix}_steps`, planted ? missing : !missing)
  return missing
}

async function fc12(app: App, planted: boolean) {
  const prefix = planted ? '38_fc12_planted' : '38_fc12_head'
  const { owner, member, other, spaceId } = await roster(app)
  const creatorPage = await app.createPage(member.user.id, { spaceId, title: 'Creator deletes' })
  const ownerPage = await app.createPage(member.user.id, { spaceId, title: 'Owner deletes' })
  const memberPage = await app.createPage(owner.user.id, { spaceId, title: 'Member blocked' })
  await lockRow(app.getSql(), owner.user.id, creatorPage.id)
  await lockRow(app.getSql(), member.user.id, ownerPage.id)
  await lockRow(app.getSql(), owner.user.id, memberPage.id)
  if (planted) {
    line(
      `${prefix}_note`,
      'e6902c30 has no lock that blocks delete, so this planted case uses a fixture that refuses archive while locked',
    )
    const creator = await archiveBlockedByLock(app.getSql(), creatorPage.id)
    const ownerResult = await archiveBlockedByLock(app.getSql(), ownerPage.id)
    const memberResult = await archiveBlockedByLock(app.getSql(), memberPage.id)
    line(`${prefix}_creator_status`, creator.status)
    line(`${prefix}_owner_status`, ownerResult.status)
    line(`${prefix}_member_status`, memberResult.status)
    line(`${prefix}_creator_archived`, creator.archived)
    line(`${prefix}_owner_archived`, ownerResult.archived)
    line(`${prefix}_member_archived`, memberResult.archived)
    return (
      creator.status === 423 &&
      ownerResult.status === 423 &&
      memberResult.status === 423 &&
      !creator.archived &&
      !ownerResult.archived &&
      !memberResult.archived
    )
  }
  const creatorStatus = await statusOf(() => app.archivePage(member.user.id, creatorPage.id))
  const ownerStatus = await statusOf(() => app.archivePage(owner.user.id, ownerPage.id))
  const memberStatus = await statusOf(() => app.archivePage(other.user.id, memberPage.id))
  const creatorRow = await readRow(app.getSql(), creatorPage.id)
  const ownerRow = await readRow(app.getSql(), ownerPage.id)
  const memberRow = await readRow(app.getSql(), memberPage.id)
  line(`${prefix}_creator_status`, creatorStatus)
  line(`${prefix}_owner_status`, ownerStatus)
  line(`${prefix}_member_status`, memberStatus)
  line(`${prefix}_creator_archived`, creatorRow.archived_at != null)
  line(`${prefix}_owner_archived`, ownerRow.archived_at != null)
  line(`${prefix}_member_archived`, memberRow.archived_at != null)
  return !(
    creatorStatus === 200 &&
    ownerStatus === 200 &&
    memberStatus === 403 &&
    creatorRow.archived_at != null &&
    ownerRow.archived_at != null &&
    memberRow.archived_at == null
  )
}

async function run(which: string, planted: boolean) {
  if (which === 'fc11') return fc11(planted)
  databaseUrl()
  ensureAuthEnv()
  const root = planted ? await materializePin() : repoRoot
  const app = await loadApp(root)
  try {
    if (which === 'fc1') return await fc1(app, planted)
    if (which === 'fc2') return await fc2(app, planted)
    if (which === 'fc3') return await fc3(app, planted)
    if (which === 'fc4') return await fc4(app, planted)
    if (which === 'fc5') return await fc5(app, planted)
    if (which === 'fc6') return await fc6(app, planted)
    if (which === 'fc7') return await fc7(app, planted)
    if (which === 'fc8') return await fc8(app, planted)
    if (which === 'fc9') return await fc9(app, planted)
    if (which === 'fc10') return await fc10(app, planted)
    if (which === 'fc12') return await fc12(app, planted)
    throw new Error(`unknown ${which}`)
  } finally {
    await app.closeDb().catch(() => undefined)
    if (planted && root !== repoRoot) rmSync(root, { recursive: true, force: true })
  }
}

const mode = process.argv[2] ?? ''
const planted = mode.endsWith('-planted')
const which = mode.replace(/-planted$/, '')

if (!/^fc(?:[1-9]|1[0-2])$/.test(which)) {
  console.error('usage: issue38-fail.ts fc1..fc12[-planted]')
  process.exit(2)
}

run(which, planted)
  .then((bug) => {
    process.exit(bug ? 1 : 0)
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'issue38 failed'
    console.error(message.split('\n').slice(0, 12).join('\n'))
    process.exit(2)
  })
