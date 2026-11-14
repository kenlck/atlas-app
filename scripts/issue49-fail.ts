import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { refuseEveryMove } from './fixtures/issue49-move.ts'
import {
  assertLocalBaseUrl,
  assertLocalDatabaseUrl,
  submitAuthForm,
} from './verify-local.ts'

const PIN = '34a6d03235abd5bae4921c94e86ebd687fb3eb8c'
const repoRoot = join(import.meta.dirname, '..')

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>

type Person = {
  user: { id: string; email: string }
  password: string
  space: { id: string }
}

type App = {
  createPage: (
    userId: string,
    input: { spaceId: string; parentId?: string | null; title?: string },
  ) => Promise<{ id: string }>
  movePage: (
    userId: string,
    input: { pageId: string; parentId: string | null },
  ) => Promise<unknown>
  archivePage: (userId: string, pageId: string) => Promise<unknown>
  getPageView: (
    userId: string,
    pageId: string,
  ) => Promise<{ id: string; parentId: string | null; updatedAt: string }>
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
  createApiToken: (
    userId: string,
    input: { name?: string; scope?: string },
  ) => Promise<{ token: string }>
  handleMcp: (request: Request) => Promise<Response>
  getSql: () => Sql
  closeDb: () => Promise<void>
}

function line(name: string, value: string | number | boolean) {
  console.log(`${name}=${value}`)
}

function redact(text: string) {
  return text
    .replace(/atl_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .split('\n')[0]
}

function databaseUrl() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required')
  assertLocalDatabaseUrl(url)
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = url
}

function ensureAuthEnv() {
  if (
    !process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_SECRET.length < 32
  ) {
    process.env.BETTER_AUTH_SECRET = 'issue49-fail-secret-not-a-credential'
  }
  if (!process.env.BETTER_AUTH_URL) {
    process.env.BETTER_AUTH_URL =
      process.env.BASE_URL || 'http://127.0.0.1:3000'
  }
}

function pinText(path: string) {
  return execFileSync('git', ['show', `${PIN}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function materializePin() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-49-'))
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
  const helpers = (await import(href('tests/helpers.ts'))) as Pick<
    App,
    'createUser'
  >
  const teams = (await import(href('src/lib/teams.ts'))) as Pick<
    App,
    'createTeam' | 'createInvite' | 'acceptInvite'
  >
  const tokens = (await import(href('src/lib/api-tokens.ts'))) as Pick<
    App,
    'createApiToken'
  >
  const mcp = (await import(href('src/lib/mcp.ts'))) as Pick<App, 'handleMcp'>
  const db = (await import(href('src/lib/db.ts'))) as Pick<
    App,
    'closeDb' | 'getSql'
  >
  return {
    createPage: pages.createPage,
    movePage: pages.movePage,
    archivePage: pages.archivePage,
    getPageView: pages.getPageView,
    createUser: helpers.createUser,
    createTeam: teams.createTeam,
    createInvite: teams.createInvite,
    acceptInvite: teams.acceptInvite,
    createApiToken: tokens.createApiToken,
    handleMcp: mcp.handleMcp,
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

async function roster(app: App, label: string) {
  const owner = await app.createUser(`${label} Owner`)
  const member = await app.createUser(`${label} Member`)
  const created = await app.createTeam(
    owner.user.id,
    `${label} ${crypto.randomUUID().slice(0, 6)}`,
  )
  const invite = await app.createInvite(
    owner.user.id,
    created.id,
    member.user.id,
  )
  await app.acceptInvite(member.user.id, invite.id)
  return { owner, member, teamId: created.id, spaceId: created.spaceId }
}

async function placement(sql: Sql, pageId: string) {
  const rows = await sql`
    select parent_id, position, archived_at from page where id = ${pageId}
  `
  const row = rows[0]
  if (!row) throw new Error('missing page')
  return {
    parent: row.parent_id == null ? '' : String(row.parent_id),
    position: Number(row.position),
    archived: row.archived_at != null,
  }
}

async function subtree(sql: Sql, pageId: string) {
  return sql`
    with recursive subtree as (
      select id, parent_id, archived_at from page where id = ${pageId}
      union all
      select child.id, child.parent_id, child.archived_at
      from page child
      inner join subtree s on child.parent_id = s.id
    )
    select id, parent_id, archived_at from subtree
  `
}

function is4xx(status: number) {
  return status >= 400 && status < 500
}

function missed(value: boolean) {
  return !value
}

function moveDelegates(source: string) {
  const start = source.indexOf('export const movePageFn')
  const end = source.indexOf('export const archivePageFn')
  if (start < 0 || end < start) return false
  const body = source.slice(start, end)
  return (
    body.includes('await movePage(context.userId, data)') &&
    !body.includes('.update(')
  )
}

function restMoveStatus(source: string) {
  if (
    source.includes('movePage') ||
    source.includes("=== 'move'") ||
    source.includes('=== "move"')
  ) {
    return 200
  }
  return 404
}

async function withApp(root: string, task: (app: App) => Promise<boolean>) {
  const app = await loadApp(root)
  try {
    return await task(app)
  } finally {
    await app.closeDb().catch(() => undefined)
    if (root !== repoRoot) rmSync(root, { recursive: true, force: true })
  }
}

async function tightRoot() {
  const root = await materializePin()
  const path = join(root, 'src/lib/pages.ts')
  writeFileSync(path, refuseEveryMove(readFileSync(path, 'utf8')))
  return root
}

async function fc1(app: App, prefix: string) {
  const { owner, member, spaceId } = await roster(app, 'Fc1')
  const parent = await app.createPage(owner.user.id, {
    spaceId,
    title: 'Teammate page',
  })
  const child = await app.createPage(owner.user.id, {
    spaceId,
    parentId: parent.id,
    title: 'Teammate child',
  })
  const grandchild = await app.createPage(owner.user.id, {
    spaceId,
    parentId: child.id,
    title: 'Teammate grandchild',
  })
  const own = await app.createPage(member.user.id, {
    spaceId,
    title: 'Member page',
  })
  const before = await placement(app.getSql(), parent.id)
  const moveStatus = await statusOf(() =>
    app.movePage(member.user.id, { pageId: parent.id, parentId: own.id }),
  )
  const deleteStatus = await statusOf(() =>
    app.archivePage(member.user.id, own.id),
  )
  const rows = await subtree(app.getSql(), parent.id)
  const ids = new Set(rows.map((row) => String(row.id)))
  const archivedNull =
    rows.length > 0 && rows.every((row) => row.archived_at == null)
  const present = [parent.id, child.id, grandchild.id].every((id) =>
    ids.has(id),
  )
  const ownerRead = (
    await Promise.all(
      [parent.id, child.id, grandchild.id].map((id) =>
        statusOf(() => app.getPageView(owner.user.id, id)),
      ),
    )
  ).every((status) => status === 200)
  const after = await placement(app.getSql(), parent.id)
  const parentSame = after.parent === before.parent
  line(`${prefix}_move_status`, moveStatus)
  line(`${prefix}_delete_status`, deleteStatus)
  line(`${prefix}_archived_null`, archivedNull && present)
  line(`${prefix}_owner_read`, ownerRead)
  line(`${prefix}_parent_same`, parentSame)
  return (
    !is4xx(moveStatus) || !archivedNull || !present || !ownerRead || !parentSame
  )
}

async function mcpParent(
  app: App,
  userId: string,
  pageId: string,
  parentId: string,
) {
  const token = await app.createApiToken(userId, {
    name: 'move',
    scope: 'read_write',
  })
  const current = await app.getPageView(userId, pageId)
  const response = await app.handleMcp(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'update_page',
          arguments: {
            page_id: pageId,
            parent_id: parentId,
            updated_at: current.updatedAt,
          },
        },
      }),
    }),
  )
  await response.text().catch(() => '')
  return response.status
}

async function sessionCookie(base: string, email: string, password: string) {
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password }),
  })
  if (response.status !== 200)
    throw new Error(`sign-in status ${response.status}`)
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  const raw =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const cookie = raw
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry.includes('='))
    .join('; ')
  if (!cookie) throw new Error('sign-in cookie missing')
  await response.text().catch(() => '')
  return cookie
}

async function fc1b(app: App, prefix: string, planted: boolean) {
  const fnSource = planted
    ? pinText('src/server/fns.ts')
    : readFileSync(join(repoRoot, 'src/server/fns.ts'), 'utf8')
  const apiSource = planted
    ? pinText('src/lib/atlas-api.ts')
    : readFileSync(join(repoRoot, 'src/lib/atlas-api.ts'), 'utf8')
  if (!moveDelegates(fnSource))
    throw new Error('movePageFn does not delegate to movePage')
  const { owner, member, spaceId } = await roster(app, 'Fc1b')
  const sql = app.getSql()

  const moveTarget = await app.createPage(owner.user.id, {
    spaceId,
    title: 'Move target',
  })
  const moveMine = await app.createPage(member.user.id, {
    spaceId,
    title: 'Move mine',
  })
  const beforeMove = await placement(sql, moveTarget.id)
  const moveStatus = await statusOf(() =>
    app.movePage(member.user.id, {
      pageId: moveTarget.id,
      parentId: moveMine.id,
    }),
  )
  const afterMove = await placement(sql, moveTarget.id)
  line(`${prefix}_movePageFn_status`, moveStatus)
  line(
    `${prefix}_movePageFn_parent_same`,
    afterMove.parent === beforeMove.parent,
  )

  const mcpTarget = await app.createPage(owner.user.id, {
    spaceId,
    title: 'Mcp target',
  })
  const mcpMine = await app.createPage(member.user.id, {
    spaceId,
    title: 'Mcp mine',
  })
  const beforeMcp = await placement(sql, mcpTarget.id)
  const mcpStatus = await mcpParent(
    app,
    member.user.id,
    mcpTarget.id,
    mcpMine.id,
  )
  const afterMcp = await placement(sql, mcpTarget.id)
  line(`${prefix}_mcp_update_page_status`, mcpStatus)
  line(
    `${prefix}_mcp_update_page_parent_same`,
    afterMcp.parent === beforeMcp.parent,
  )
  if (planted)
    line(
      `${prefix}_mcp_already_refused`,
      is4xx(mcpStatus) && afterMcp.parent === beforeMcp.parent,
    )

  const restTarget = await app.createPage(owner.user.id, {
    spaceId,
    title: 'Rest target',
  })
  const restMine = await app.createPage(member.user.id, {
    spaceId,
    title: 'Rest mine',
  })
  const beforeRest = await placement(sql, restTarget.id)
  let restStatus = restMoveStatus(apiSource)
  if (!planted) {
    const base = assertLocalBaseUrl(process.env.BASE_URL ?? '')
    const cookie = await sessionCookie(base, member.user.email, member.password)
    const response = await fetch(
      `${base}/api/atlas/pages/${restTarget.id}/move`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: base,
        },
        body: JSON.stringify({ parentId: restMine.id }),
      },
    )
    await response.text().catch(() => '')
    restStatus = response.status
  }
  const afterRest = await placement(sql, restTarget.id)
  line(`${prefix}_rest_move_status`, restStatus)
  line(
    `${prefix}_rest_move_parent_same`,
    afterRest.parent === beforeRest.parent,
  )
  if (planted)
    line(`${prefix}_rest_route`, restStatus === 404 ? 'absent' : 'present')

  const createTarget = await app.createPage(owner.user.id, {
    spaceId,
    title: 'Create target',
  })
  const beforeCreate = await placement(sql, createTarget.id)
  await app.createPage(member.user.id, {
    spaceId,
    parentId: createTarget.id,
    title: 'Created child',
  })
  const afterCreate = await placement(sql, createTarget.id)
  const reparents = afterCreate.parent !== beforeCreate.parent
  line(`${prefix}_createPageFn_reparents`, reparents)

  const moveAttack = !is4xx(moveStatus)
  const mcpAttack = !is4xx(mcpStatus) || afterMcp.parent !== beforeMcp.parent
  const restAttack =
    !is4xx(restStatus) || afterRest.parent !== beforeRest.parent
  return moveAttack || mcpAttack || restAttack || reparents
}

async function ownMoves(app: App, userId: string, spaceId: string) {
  const first = await app.createPage(userId, { spaceId, title: 'Own first' })
  const second = await app.createPage(userId, { spaceId, title: 'Own second' })
  const before = await placement(app.getSql(), first.id)
  const reorderStatus = await statusOf(() =>
    app.movePage(userId, { pageId: first.id, parentId: null }),
  )
  const afterReorder = await placement(app.getSql(), first.id)
  const parentStatus = await statusOf(() =>
    app.movePage(userId, { pageId: first.id, parentId: second.id }),
  )
  const afterParent = await placement(app.getSql(), first.id)
  return {
    reorderStatus,
    parentStatus,
    reordered:
      reorderStatus === 200 &&
      afterReorder.parent === before.parent &&
      afterReorder.position !== before.position,
    parentChanged: parentStatus === 200 && afterParent.parent === second.id,
  }
}

async function fc2(prefix: string, planted: boolean) {
  if (!planted) {
    return withApp(repoRoot, async (app) => {
      const { member, spaceId } = await roster(app, 'Fc2')
      const result = await ownMoves(app, member.user.id, spaceId)
      line(`${prefix}_reorder_status`, result.reorderStatus)
      line(`${prefix}_parent_status`, result.parentStatus)
      line(`${prefix}_reordered`, result.reordered)
      line(`${prefix}_parent_changed`, result.parentChanged)
      return !(result.reordered && result.parentChanged)
    })
  }
  const plain = await materializePin()
  const allowed = await withApp(plain, async (app) => {
    const { member, spaceId } = await roster(app, 'Fc2plain')
    const result = await ownMoves(app, member.user.id, spaceId)
    return result.reordered && result.parentChanged
  })
  line(`${prefix}_already_allowed`, allowed)
  if (!allowed)
    throw new Error('34a6d032 did not let a member move their own page')
  line(`${prefix}_fixture`, 'too-strict')
  const root = await tightRoot()
  return withApp(root, async (app) => {
    const { member, spaceId } = await roster(app, 'Fc2tight')
    const result = await ownMoves(app, member.user.id, spaceId)
    line(`${prefix}_status`, result.reorderStatus)
    return result.reorderStatus !== 200
  })
}

async function fc3(prefix: string, planted: boolean) {
  const check = async (app: App) => {
    const { owner, member, spaceId } = await roster(app, 'Fc3')
    const folder = await app.createPage(owner.user.id, {
      spaceId,
      title: 'Owner folder',
    })
    const theirs = await app.createPage(member.user.id, {
      spaceId,
      title: 'Member page',
    })
    const status = await statusOf(() =>
      app.movePage(owner.user.id, { pageId: theirs.id, parentId: folder.id }),
    )
    const after = await placement(app.getSql(), theirs.id)
    return {
      status,
      parentChanged: status === 200 && after.parent === folder.id,
    }
  }
  if (!planted) {
    return withApp(repoRoot, async (app) => {
      const result = await check(app)
      line(`${prefix}_status`, result.status)
      line(`${prefix}_parent_changed`, result.parentChanged)
      return !result.parentChanged
    })
  }
  const plain = await materializePin()
  const allowed = await withApp(
    plain,
    async (app) => (await check(app)).parentChanged,
  )
  line(`${prefix}_already_allowed`, allowed)
  if (!allowed)
    throw new Error('34a6d032 did not let the team owner move a page')
  line(`${prefix}_fixture`, 'too-strict')
  const root = await tightRoot()
  return withApp(root, async (app) => {
    const result = await check(app)
    line(`${prefix}_status`, result.status)
    return result.status !== 200
  })
}

async function fc4(prefix: string, planted: boolean) {
  const check = async (app: App) => {
    const owner = await app.createUser('Fc4 Personal')
    const folder = await app.createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Folder',
    })
    const note = await app.createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Note',
    })
    const status = await statusOf(() =>
      app.movePage(owner.user.id, { pageId: note.id, parentId: folder.id }),
    )
    const after = await placement(app.getSql(), note.id)
    return {
      status,
      parentChanged: status === 200 && after.parent === folder.id,
    }
  }
  if (!planted) {
    return withApp(repoRoot, async (app) => {
      const result = await check(app)
      line(`${prefix}_status`, result.status)
      line(`${prefix}_parent_changed`, result.parentChanged)
      return !result.parentChanged
    })
  }
  const plain = await materializePin()
  const allowed = await withApp(
    plain,
    async (app) => (await check(app)).parentChanged,
  )
  line(`${prefix}_already_allowed`, allowed)
  if (!allowed)
    throw new Error('34a6d032 did not let the personal owner move a page')
  line(`${prefix}_fixture`, 'too-strict')
  const root = await tightRoot()
  return withApp(root, async (app) => {
    const result = await check(app)
    line(`${prefix}_status`, result.status)
    return result.status !== 200
  })
}

function baseUrl() {
  if (!process.env.BASE_URL) throw new Error('BASE_URL is required')
  return assertLocalBaseUrl(process.env.BASE_URL)
}

async function signIn(
  page: Page,
  base: string,
  email: string,
  password: string,
) {
  await page.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const field = document.getElementById('email')
    if (!field) return false
    return Object.getOwnPropertyNames(field).some((key) =>
      key.startsWith('__reactProps$'),
    )
  })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
  await page.waitForFunction(() => !location.pathname.startsWith('/sign-in'))
}

async function openDrawer(page: Page) {
  const opener = page.getByRole('button', { name: 'Open pages' })
  if (await opener.isVisible()) {
    await opener.click()
    await page.locator('.side.open').waitFor()
  }
}

async function openRowMenu(page: Page, title: string) {
  await openDrawer(page)
  const row = page.locator('.tree a.it').filter({ hasText: title }).first()
  await row.waitFor()
  const button = row.locator('xpath=following-sibling::button')
  await button.waitFor()
  await page.waitForFunction((name) => {
    const link = [...document.querySelectorAll('.tree a.it')].find((node) =>
      (node.textContent || '').includes(name),
    )
    const control = link?.nextElementSibling
    return (
      control instanceof HTMLButtonElement &&
      Object.getOwnPropertyNames(control).some((key) =>
        key.startsWith('__reactProps'),
      )
    )
  }, title)
  await button.click()
  await page.locator('.menu').filter({ hasText: 'Rename' }).waitFor()
}

async function shot(page: Page, name: string) {
  const buf = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  for (const dir of [
    join(repoRoot, 'artifacts', sha),
    '/opt/cursor/artifacts',
  ]) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), buf)
  }
  line('screenshot', name)
}

async function handleCount(page: Page, title: string) {
  const row = page.locator('.tree a.it').filter({ hasText: title }).first()
  return row.locator('.drag-handle').count()
}

async function menuHasMove(page: Page) {
  const labels = await page.locator('.menu button').allInnerTexts()
  return labels.some((label) => label.trim() === 'Move')
}

async function closeMenu(page: Page) {
  const open = page.locator('.row-more[aria-expanded="true"]')
  if ((await open.count()) > 0) await open.first().click()
}

function nestedExpression(child: string, parent: string) {
  return `(() => {
    const childTitle = ${JSON.stringify(child)};
    const parentTitle = ${JSON.stringify(parent)};
    const link = (title) => [...document.querySelectorAll('.tree a.it')].find((node) => (node.textContent || '').includes(title));
    const childRow = link(childTitle) && link(childTitle).parentElement && link(childTitle).parentElement.parentElement;
    const parentRow = link(parentTitle) && link(parentTitle).parentElement && link(parentTitle).parentElement.parentElement;
    return Boolean(childRow && parentRow && parentRow.contains(childRow) && parentRow !== childRow);
  })()`
}

async function isNested(page: Page, child: string, parent: string) {
  return page.evaluate(nestedExpression(child, parent))
}

async function fc5(prefix: string, planted: boolean) {
  if (planted) {
    const tree = pinText('src/components/PageTree.tsx')
    const moveAt = tree.indexOf('onMove(node.id)')
    const before =
      moveAt < 0 ? '' : tree.slice(Math.max(0, moveAt - 400), moveAt)
    const ungated = moveAt >= 0 && !before.includes('canDelete')
    line(`${prefix}_move_ungated`, ungated)
    return ungated
  }
  const base = baseUrl()
  return withApp(repoRoot, async (app) => {
    const { owner, member, spaceId } = await roster(app, 'Fc5')
    await app.createPage(member.user.id, { spaceId, title: 'Member row' })
    await app.createPage(owner.user.id, { spaceId, title: 'Teammate row' })
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    })
    page.setDefaultTimeout(20000)
    try {
      await signIn(page, base, member.user.email, member.password)
      await page.goto(`${base}/s/${spaceId}`, { waitUntil: 'domcontentloaded' })
      await page
        .locator('.tree a.it')
        .filter({ hasText: 'Teammate row' })
        .waitFor()
      const foreignHandle = await handleCount(page, 'Teammate row')
      await openRowMenu(page, 'Teammate row')
      const foreignMove = await menuHasMove(page)
      await shot(page, '49-fc5-teammate-1280.png')
      await closeMenu(page)
      await page.setViewportSize({ width: 390, height: 844 })
      await openRowMenu(page, 'Teammate row')
      const foreignMoveNarrow = await menuHasMove(page)
      const foreignHandleNarrow = await handleCount(page, 'Teammate row')
      await shot(page, '49-fc5-teammate-390.png')
      await closeMenu(page)
      await page.setViewportSize({ width: 1280, height: 800 })
      await openRowMenu(page, 'Member row')
      const ownMove = await menuHasMove(page)
      const ownHandle = await handleCount(page, 'Member row')
      line(
        `${prefix}_foreign_handle`,
        foreignHandle !== 0 || foreignHandleNarrow !== 0,
      )
      line(`${prefix}_foreign_move`, foreignMove || foreignMoveNarrow)
      line(`${prefix}_own_handle`, ownHandle === 1)
      line(`${prefix}_own_move`, ownMove)
      return (
        foreignHandle !== 0 ||
        foreignHandleNarrow !== 0 ||
        foreignMove ||
        foreignMoveNarrow ||
        ownHandle !== 1 ||
        !ownMove
      )
    } finally {
      await browser.close()
    }
  })
}

async function fc6(prefix: string, planted: boolean) {
  if (planted) {
    const frame = pinText('src/components/AppFrame.tsx')
    const missing = !frame.includes("You can't move this page.")
    line(`${prefix}_toast_missing`, missing)
    return missing
  }
  const base = baseUrl()
  return withApp(repoRoot, async (app) => {
    const { member, spaceId } = await roster(app, 'Fc6')
    const mine = await app.createPage(member.user.id, {
      spaceId,
      title: 'Snap mine',
    })
    await app.createPage(member.user.id, { spaceId, title: 'Snap nest' })
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    })
    page.setDefaultTimeout(20000)
    let moved = false
    await page.route(/_serverFn|serverFn/, async (route) => {
      const body = route.request().postData() ?? ''
      if (
        route.request().method() === 'POST' &&
        body.includes(mine.id) &&
        body.includes('parentId')
      ) {
        const saw = await page
          .waitForFunction(
            nestedExpression('Snap mine', 'Snap nest'),
            undefined,
            {
              timeout: 5000,
            },
          )
          .then(() => true)
          .catch(() => false)
        moved = moved || saw
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: '{"error":"Forbidden"}',
        })
        return
      }
      await route.continue()
    })
    try {
      await signIn(page, base, member.user.email, member.password)
      await page.goto(`${base}/s/${spaceId}`, { waitUntil: 'domcontentloaded' })
      await page
        .locator('.tree a.it')
        .filter({ hasText: 'Snap mine' })
        .waitFor()
      await openRowMenu(page, 'Snap mine')
      await page
        .locator('.menu')
        .getByRole('button', { name: 'Move', exact: true })
        .click()
      await page.getByRole('heading', { name: 'Move page' }).waitFor()
      await page.getByRole('button', { name: 'Snap nest', exact: true }).click()
      const toast = page.getByText("You can't move this page.", { exact: true })
      const apart = `!${nestedExpression('Snap mine', 'Snap nest')}`
      await toast.waitFor()
      await page.waitForFunction(apart)
      const snapped = !(await isNested(page, 'Snap mine', 'Snap nest'))
      await shot(page, '49-fc6-toast-1280.png')
      await toast.waitFor({ state: 'hidden', timeout: 6000 })
      await page.setViewportSize({ width: 390, height: 844 })
      await openRowMenu(page, 'Snap mine')
      await page
        .locator('.menu')
        .getByRole('button', { name: 'Move', exact: true })
        .click()
      await page.getByRole('heading', { name: 'Move page' }).waitFor()
      await page.getByRole('button', { name: 'Snap nest', exact: true }).click()
      await toast.waitFor()
      await page.waitForFunction(apart)
      const snappedNarrow = !(await isNested(page, 'Snap mine', 'Snap nest'))
      await shot(page, '49-fc6-toast-390.png')
      line(`${prefix}_moved`, moved)
      line(`${prefix}_snapped`, snapped && snappedNarrow)
      line(`${prefix}_toast`, true)
      return missed(moved) || missed(snapped) || missed(snappedNarrow)
    } finally {
      await browser.close()
    }
  })
}

async function run(which: string, planted: boolean) {
  const prefix = `49_${which}_${planted ? 'planted' : 'head'}`
  line(`${prefix}_pin`, PIN)
  if (!planted || (which !== 'fc5' && which !== 'fc6')) {
    databaseUrl()
    ensureAuthEnv()
  }
  if (which === 'fc5') return fc5(prefix, planted)
  if (which === 'fc6') return fc6(prefix, planted)
  if (which === 'fc2') return fc2(prefix, planted)
  if (which === 'fc3') return fc3(prefix, planted)
  if (which === 'fc4') return fc4(prefix, planted)
  const root = planted ? await materializePin() : repoRoot
  return withApp(root, async (app) => {
    if (which === 'fc1') return fc1(app, prefix)
    if (which === 'fc1b') return fc1b(app, prefix, planted)
    throw new Error(`unknown ${which}`)
  })
}

const mode = process.argv[2] ?? ''
const planted = mode.endsWith('-planted')
const which = mode.replace(/-planted$/, '')

if (!['fc1', 'fc1b', 'fc2', 'fc3', 'fc4', 'fc5', 'fc6'].includes(which)) {
  console.error('usage: issue49-fail.ts fc1|fc1b|fc2|fc3|fc4|fc5|fc6[-planted]')
  process.exit(2)
}

run(which, planted)
  .then((bug) => {
    process.exit(bug ? 1 : 0)
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'issue49 failed'
    console.error(redact(message))
    process.exit(2)
  })
