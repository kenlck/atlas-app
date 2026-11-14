import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { assertLocalBaseUrl, assertLocalDatabaseUrl, submitAuthForm } from './verify-local.ts'

const PIN = '48258d6067f510f4d1bfe9c9655de912d2f43d76'
const repoRoot = join(import.meta.dirname, '..')
const PASSWORD = 'issue44-password'
const LIBRARY_PASSWORD = 'correct-horse-battery'

type App = {
  archivePage: (userId: string, pageId: string) => Promise<{ ok: true }>
  createPage: (
    userId: string,
    input: {
      spaceId: string
      parentId?: string | null
      title?: string
      kind?: 'doc' | 'whiteboard'
    },
  ) => Promise<{ id: string; title: string }>
  createDiagram: (userId: string, pageId: string) => Promise<{ id: string }>
  savePage: (
    userId: string,
    input: { pageId: string; title: string; body: unknown },
  ) => Promise<{ id: string; title: string; body: unknown }>
  getPageView: (userId: string, pageId: string) => Promise<{ id: string; title: string; body: unknown }>
  listPageTree: (
    userId: string,
    spaceId: string,
  ) => Promise<{ tree: Array<{ id: string; children: Array<{ id: string }> }> }>
  searchVisiblePages: (
    userId: string,
    query: string,
  ) => Promise<Array<{ id: string }>>
  createUser: (name?: string) => Promise<{
    user: { id: string; email: string }
    space: { id: string }
  }>
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
  handleAtlasApi: (request: Request) => Promise<Response>
  getSql: () => {
    unsafe: (query: string, params: unknown[]) => Promise<unknown>
  }
  closeDb: () => Promise<void>
}

function redact(text: string) {
  return text
    .replace(/atl_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .replace(/("password"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .split('\n')[0]
}

function databaseUrl() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required')
  assertLocalDatabaseUrl(url)
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = url
  return url
}

function ensureAuthEnv() {
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    process.env.BETTER_AUTH_SECRET = 'issue44-fail-secret-not-a-credential'
  }
  if (!process.env.BETTER_AUTH_URL) {
    process.env.BETTER_AUTH_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
  }
}

function pinText(path: string) {
  return execFileSync('git', ['show', `${PIN}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function pinIncludes(path: string, needle: string) {
  try {
    return pinText(path).includes(needle)
  } catch {
    return false
  }
}

function materializePin() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-44-'))
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
    'createTeam' | 'createInvite' | 'acceptInvite'
  >
  const tokens = (await import(href('src/lib/api-tokens.ts'))) as Pick<App, 'createApiToken'>
  const mcp = (await import(href('src/lib/mcp.ts'))) as Pick<App, 'handleMcp'>
  const atlas = (await import(href('src/lib/atlas-api.ts'))) as Pick<App, 'handleAtlasApi'>
  const search = (await import(href('src/lib/search.ts'))) as Pick<App, 'searchVisiblePages'>
  const db = (await import(href('src/lib/db.ts'))) as Pick<App, 'closeDb' | 'getSql'>
  return {
    archivePage: pages.archivePage,
    createPage: pages.createPage,
    createDiagram: pages.createDiagram,
    savePage: pages.savePage,
    getPageView: pages.getPageView,
    listPageTree: pages.listPageTree,
    searchVisiblePages: search.searchVisiblePages,
    createUser: helpers.createUser,
    createTeam: teams.createTeam,
    createInvite: teams.createInvite,
    acceptInvite: teams.acceptInvite,
    createApiToken: tokens.createApiToken,
    handleMcp: mcp.handleMcp,
    handleAtlasApi: atlas.handleAtlasApi,
    getSql: db.getSql,
    closeDb: db.closeDb,
  }
}

function line(name: string, value: string | number | boolean) {
  console.log(`${name}=${value}`)
}

async function statusOf(attempt: () => Promise<unknown>): Promise<number> {
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

function allowed(status: number) {
  return status === 403 || status === 404
}

async function roster(app: App, label: string) {
  const owner = await app.createUser(`${label} Owner`)
  const member = await app.createUser(`${label} Member`)
  const outsider = await app.createUser(`${label} Outsider`)
  const created = await app.createTeam(owner.user.id, `${label} ${crypto.randomUUID().slice(0, 6)}`)
  const invite = await app.createInvite(owner.user.id, created.id, member.user.id)
  await app.acceptInvite(member.user.id, invite.id)
  return { owner, member, outsider, teamId: created.id, spaceId: created.spaceId }
}

function treeIds(nodes: Array<{ id: string; children?: Array<{ id: string; children?: never }> }>): string[] {
  return nodes.flatMap((node) => [node.id, ...treeIds(node.children ?? [])])
}

async function visible(app: App, userId: string, spaceId: string, pageId: string, title: string) {
  const tree = await app.listPageTree(userId, spaceId)
  const inTree = treeIds(tree.tree).includes(pageId)
  const hits = await app.searchVisiblePages(userId, title)
  const inSearch = hits.some((hit) => hit.id === pageId)
  const view = await statusOf(() => app.getPageView(userId, pageId))
  return { inTree, inSearch, view }
}

function mcpCall(token: string, name: string, args: Record<string, unknown>) {
  return new Request('http://127.0.0.1:3000/mcp', {
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
  })
}

function mcpList(token: string) {
  return new Request('http://127.0.0.1:3000/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

async function toolStatus(app: App, token: string, name: string, args: Record<string, unknown>) {
  const response = await app.handleMcp(mcpCall(token, name, args))
  return response.status
}

async function atlasStatus(app: App, method: string, path: string) {
  const response = await app.handleAtlasApi(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
    }),
  )
  return response.status
}

const DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

async function fc1(app: App, prefix: string) {
  const { owner, member, spaceId } = await roster(app, 'Fc1')
  const page = await app.createPage(owner.user.id, { spaceId, title: 'Owned note' })
  const status = await statusOf(() => app.archivePage(member.user.id, page.id))
  const after = await visible(app, owner.user.id, spaceId, page.id, 'Owned note')
  line(`${prefix}_member_status`, status)
  line(`${prefix}_page_kept`, after.inTree && after.view === 200)
  const menu = prefix.endsWith('planted')
    ? pinIncludes('src/components/PageTree.tsx', 'Archive') &&
      !pinIncludes('src/components/PageTree.tsx', 'canDelete')
    : false
  line(`${prefix}_menu_open`, menu)
  return !allowed(status) || !after.inTree || after.view !== 200 || menu
}

async function fc2(app: App, prefix: string) {
  const { owner, outsider, spaceId } = await roster(app, 'Fc2')
  const page = await app.createPage(owner.user.id, { spaceId, title: 'Secret note' })
  const outsiderStatus = await statusOf(() => app.archivePage(outsider.user.id, page.id))
  const token = await app.createApiToken(outsider.user.id, {
    name: 'none',
    scope: 'read_write',
  })
  const tool = await toolStatus(app, token.token, 'delete_page', { page_id: page.id })
  const after = await visible(app, owner.user.id, spaceId, page.id, 'Secret note')
  line(`${prefix}_outsider_status`, outsiderStatus)
  line(`${prefix}_token_status`, tool)
  line(`${prefix}_page_kept`, after.inTree && after.view === 200)
  return outsiderStatus !== 404 || tool !== 404 || !after.inTree || after.view !== 200
}

async function fc3(app: App, prefix: string, browserOk: boolean) {
  const { owner, member, spaceId } = await roster(app, 'Fc3')
  const owned = await app.createPage(owner.user.id, { spaceId, title: 'Owner note' })
  const made = await app.createPage(member.user.id, {
    spaceId,
    parentId: owned.id,
    title: 'Member note',
  })
  const memberStatus = await statusOf(() => app.archivePage(member.user.id, owned.id))
  const kept = await visible(app, owner.user.id, spaceId, owned.id, 'Owner note')
  const creatorStatus = await statusOf(() => app.archivePage(member.user.id, made.id))
  const ownerStatus = await statusOf(() => app.archivePage(owner.user.id, owned.id))
  const personal = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Personal note',
  })
  const personalStatus = await statusOf(() => app.archivePage(owner.user.id, personal.id))
  line(`${prefix}_member_status`, memberStatus)
  line(`${prefix}_creator_status`, creatorStatus)
  line(`${prefix}_owner_status`, ownerStatus)
  line(`${prefix}_personal_status`, personalStatus)
  line(`${prefix}_dialog_safe`, browserOk)
  const memberKept = memberStatus === 403 && kept.view === 200
  return (
    !memberKept ||
    creatorStatus !== 200 ||
    ownerStatus !== 200 ||
    personalStatus !== 200 ||
    !browserOk
  )
}

async function fc5(app: App, prefix: string) {
  const { owner, member, spaceId } = await roster(app, 'Fc5')
  const parent = await app.createPage(owner.user.id, { spaceId, title: 'Parent five' })
  const child = await app.createPage(owner.user.id, {
    spaceId,
    parentId: parent.id,
    title: 'Child five',
  })
  const memberStatus = await statusOf(() => app.archivePage(member.user.id, parent.id))
  const removed = memberStatus === 200
  if (memberStatus === 403) await app.archivePage(owner.user.id, parent.id)
  const parentView = await statusOf(() => app.getPageView(owner.user.id, parent.id))
  const childView = await statusOf(() => app.getPageView(owner.user.id, child.id))
  const tree = await app.listPageTree(owner.user.id, spaceId)
  const ids = treeIds(tree.tree)
  const search = await app.searchVisiblePages(owner.user.id, 'five')
  const token = await app.createApiToken(owner.user.id, { name: 'read', scope: 'read' })
  const mcpParent = await toolStatus(app, token.token, 'read_page', { page_id: parent.id })
  const mcpChild = await toolStatus(app, token.token, 'get_page', { page_id: child.id })
  let url = 404
  if (process.env.BASE_URL && prefix.endsWith('head')) {
    const base = assertLocalBaseUrl(process.env.BASE_URL)
    const cookie = await sessionCookie(base, owner.user.email, LIBRARY_PASSWORD)
    const response = await fetch(`${base}/s/${spaceId}/p/${parent.id}`, {
      headers: { cookie },
      redirect: 'manual',
    })
    url = response.status
  }
  line(`${prefix}_member_status`, memberStatus)
  line(`${prefix}_parent_status`, parentView)
  line(`${prefix}_child_status`, childView)
  line(`${prefix}_tree`, ids.includes(parent.id) || ids.includes(child.id))
  line(`${prefix}_search`, search.some((hit) => hit.id === parent.id || hit.id === child.id))
  line(`${prefix}_mcp_parent`, mcpParent)
  line(`${prefix}_mcp_child`, mcpChild)
  line(`${prefix}_url`, url)
  return (
    removed ||
    !allowed(memberStatus) ||
    parentView !== 404 ||
    childView !== 404 ||
    ids.includes(parent.id) ||
    ids.includes(child.id) ||
    search.some((hit) => hit.id === parent.id || hit.id === child.id) ||
    mcpParent !== 404 ||
    mcpChild !== 404 ||
    url !== 404
  )
}

async function fc6(app: App, prefix: string) {
  const { owner, member, spaceId } = await roster(app, 'Fc6')
  const board = await app.createPage(owner.user.id, {
    spaceId,
    title: 'Board six',
    kind: 'whiteboard',
  })
  const memberStatus = await statusOf(() => app.archivePage(member.user.id, board.id))
  line(`${prefix}_member_status`, memberStatus)
  if (memberStatus === 403) await app.archivePage(owner.user.id, board.id)
  const base = baseUrl()
  const cookie = await sessionCookie(base, owner.user.email, LIBRARY_PASSWORD)
  const missing = await fetch(`${base}/api/drawings?drawingId=missing-drawing`, {
    headers: { cookie },
  })
  const loaded = await fetch(`${base}/api/drawings?pageId=${board.id}`, {
    headers: { cookie },
  })
  const missingText = await missing.text()
  const loadedText = await loaded.text()
  const same = loadedText === missingText && !loadedText.includes('elements')
  line(`${prefix}_drawing_status`, loaded.status)
  line(`${prefix}_body_matches_missing`, same)
  return !allowed(memberStatus) || loaded.status !== 404 || !same
}

async function fc7(app: App, prefix: string) {
  const { owner, member, spaceId } = await roster(app, 'Fc7')
  const target = await app.createPage(owner.user.id, { spaceId, title: 'Linked seven' })
  const holder = await app.createPage(owner.user.id, { spaceId, title: 'Holder seven' })
  const body = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'See the note',
            marks: [{ type: 'link', attrs: { href: `/s/${spaceId}/p/${target.id}` } }],
          },
        ],
      },
    ],
  }
  await app.savePage(owner.user.id, { pageId: holder.id, title: 'Holder seven', body })
  const memberStatus = await statusOf(() => app.archivePage(member.user.id, target.id))
  if (memberStatus === 403) await app.archivePage(owner.user.id, target.id)
  const holderView = await app.getPageView(owner.user.id, holder.id).catch(() => null)
  const targetStatus = await statusOf(() => app.getPageView(owner.user.id, target.id))
  const text = JSON.stringify(holderView?.body ?? {})
  line(`${prefix}_member_status`, memberStatus)
  line(`${prefix}_holder_loaded`, holderView?.id === holder.id)
  line(`${prefix}_link_kept`, text.includes(target.id))
  line(`${prefix}_target_status`, targetStatus)
  return (
    memberStatus === 200 ||
    holderView?.id !== holder.id ||
    !text.includes(target.id) ||
    targetStatus !== 404
  )
}

async function fc8(app: App, prefix: string) {
  const { owner, member, outsider, spaceId } = await roster(app, 'Fc8')
  const page = await app.createPage(owner.user.id, { spaceId, title: 'Status eight' })
  const memberStatus = await statusOf(() => app.archivePage(member.user.id, page.id))
  const outsiderStatus = await statusOf(() => app.archivePage(outsider.user.id, page.id))
  const missing = await statusOf(() => app.archivePage(owner.user.id, 'missing-page'))
  const ownerStatus = await statusOf(() => app.archivePage(owner.user.id, page.id))
  const repeat = await statusOf(() => app.archivePage(owner.user.id, page.id))
  const statuses = [memberStatus, outsiderStatus, missing, ownerStatus, repeat]
  line(`${prefix}_member_status`, memberStatus)
  line(`${prefix}_outsider_status`, outsiderStatus)
  line(`${prefix}_missing_status`, missing)
  line(`${prefix}_owner_status`, ownerStatus)
  line(`${prefix}_repeat_status`, repeat)
  line(`${prefix}_has_500`, statuses.includes(500))
  return statuses.includes(500) || memberStatus === 200 || outsiderStatus !== 404 || ownerStatus !== 200
}

async function fc14(app: App, prefix: string) {
  const source = prefix.endsWith('planted')
    ? pinText('src/lib/pages.ts')
    : readFileSync(join(repoRoot, 'src/lib/pages.ts'), 'utf8')
  const start = source.indexOf('export async function archivePage')
  const next = source.indexOf('export async function', start + 10)
  const body = source.slice(start, next)
  const locked = body.includes('lockWritablePage') || body.includes("for('update'")
  const { owner, spaceId } = await roster(app, 'Fc14')
  const page = await app.createPage(owner.user.id, { spaceId, title: 'Race fourteen' })
  const raced = await Promise.all([
    statusOf(() => app.archivePage(owner.user.id, page.id)),
    statusOf(() =>
      app.savePage(owner.user.id, {
        pageId: page.id,
        title: 'Race fourteen saved',
        body: DOC,
      }),
    ),
  ])
  line(`${prefix}_lock_order`, locked)
  line(`${prefix}_archive_status`, raced[0])
  line(`${prefix}_save_status`, raced[1])
  return !locked || raced.some((status) => status === 500)
}

async function fc16(app: App, prefix: string) {
  const { owner, member, spaceId } = await roster(app, 'Fc16')
  const parent = await app.createPage(owner.user.id, { spaceId, title: 'Parent sixteen' })
  const child = await app.createPage(member.user.id, {
    spaceId,
    parentId: parent.id,
    title: 'Child sixteen',
  })
  const memberStatus = await statusOf(() => app.archivePage(member.user.id, parent.id))
  if (memberStatus === 403) await app.archivePage(owner.user.id, parent.id)
  const tree = await app.listPageTree(member.user.id, spaceId)
  const ids = treeIds(tree.tree)
  const childStatus = await statusOf(() => app.getPageView(member.user.id, child.id))
  const search = await app.searchVisiblePages(member.user.id, 'sixteen')
  line(`${prefix}_member_status`, memberStatus)
  line(`${prefix}_child_in_tree`, ids.includes(child.id))
  line(`${prefix}_child_status`, childStatus)
  line(`${prefix}_search`, search.some((hit) => hit.id === child.id || hit.id === parent.id))
  return (
    memberStatus === 200 ||
    ids.includes(child.id) ||
    ids.includes(parent.id) ||
    childStatus !== 404 ||
    search.some((hit) => hit.id === child.id || hit.id === parent.id)
  )
}

async function fc17(app: App, prefix: string) {
  const { owner, spaceId } = await roster(app, 'Fc17')
  const page = await app.createPage(owner.user.id, { spaceId, title: 'Tool seventeen' })
  const token = await app.createApiToken(owner.user.id, { name: 'writer', scope: 'read_write' })
  const listed = await app.handleMcp(mcpList(token.token))
  const listText = await listed.text()
  const names = ['delete_page', 'archive_page', 'restore_page', 'unarchive_page']
  const listedTools = names.some((name) => listText.includes(`"name":"${name}"`))
  const called = await toolStatus(app, token.token, 'delete_page', { page_id: page.id })
  const archived = await toolStatus(app, token.token, 'archive_page', { page_id: page.id })
  await app.archivePage(owner.user.id, page.id)
  const read = await toolStatus(app, token.token, 'read_page', { page_id: page.id })
  line(`${prefix}_listed`, listedTools)
  line(`${prefix}_delete_status`, called)
  line(`${prefix}_archive_status`, archived)
  line(`${prefix}_read_status`, read)
  return listedTools || called !== 404 || archived !== 404 || read !== 404
}

async function fc18(app: App, prefix: string) {
  const { owner, member, spaceId } = await roster(app, 'Fc18')
  const page = await app.createPage(owner.user.id, { spaceId, title: 'Path eighteen' })
  const direct = await statusOf(() => app.archivePage(member.user.id, page.id))
  const token = await app.createApiToken(member.user.id, { name: 'writer', scope: 'read_write' })
  const mcp = await toolStatus(app, token.token, 'archive_page', { page_id: page.id })
  const rest = await atlasStatus(app, 'POST', `/api/atlas/pages/${page.id}/archive`)
  const del = await atlasStatus(app, 'DELETE', `/api/atlas/pages/${page.id}`)
  const after = await visible(app, member.user.id, spaceId, page.id, 'Path eighteen')
  line(`${prefix}_direct_status`, direct)
  line(`${prefix}_mcp_status`, mcp)
  line(`${prefix}_rest_status`, rest)
  line(`${prefix}_delete_status`, del)
  line(`${prefix}_page_kept`, after.inTree && after.view === 200)
  const statuses = [direct, mcp, rest, del]
  return statuses.some((status) => !allowed(status)) || !after.inTree || after.view !== 200
}

async function fc19(app: App, prefix: string) {
  const { owner, spaceId } = await roster(app, 'Fc19')
  const parent = await app.createPage(owner.user.id, { spaceId, title: 'Gone nineteen' })
  const child = await app.createPage(owner.user.id, {
    spaceId,
    parentId: parent.id,
    title: 'Gone child',
  })
  await app.archivePage(owner.user.id, parent.id)
  const token = await app.createApiToken(owner.user.id, { name: 'writer', scope: 'read_write' })
  const paths = [
    await toolStatus(app, token.token, 'restore_page', { page_id: parent.id }),
    await toolStatus(app, token.token, 'unarchive_page', { page_id: parent.id }),
    await atlasStatus(app, 'POST', `/api/atlas/pages/${parent.id}/restore`),
    await atlasStatus(app, 'POST', `/api/atlas/pages/${parent.id}/unarchive`),
  ]
  const tree = await app.listPageTree(owner.user.id, spaceId)
  const ids = treeIds(tree.tree)
  const parentStatus = await statusOf(() => app.getPageView(owner.user.id, parent.id))
  const childStatus = await statusOf(() => app.getPageView(owner.user.id, child.id))
  const search = await app.searchVisiblePages(owner.user.id, 'Gone nineteen')
  const visibleHit = search.some((hit) => hit.id === parent.id || hit.id === child.id)
  line(`${prefix}_restore_statuses`, paths.join(','))
  line(`${prefix}_hidden`, !ids.includes(parent.id) && !ids.includes(child.id))
  line(`${prefix}_parent_status`, parentStatus)
  line(`${prefix}_child_status`, childStatus)
  line(`${prefix}_search`, visibleHit)
  return (
    paths.some((status) => status !== 404) ||
    ids.includes(parent.id) ||
    ids.includes(child.id) ||
    parentStatus !== 404 ||
    childStatus !== 404 ||
    visibleHit
  )
}

function baseUrl() {
  if (!process.env.BASE_URL) throw new Error('BASE_URL is required')
  return assertLocalBaseUrl(process.env.BASE_URL)
}

async function signUpBrowser(page: Page, base: string, name: string) {
  const email = `${name}.${crypto.randomUUID()}@example.com`.toLowerCase()
  await page.goto(`${base}/sign-up`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const field = document.getElementById('name')
    if (!field) return false
    return Object.getOwnPropertyNames(field).some((key) => key.startsWith('__reactProps$'))
  })
  await page.locator('#name').fill(name)
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await submitAuthForm(page, 'Create account', '/api/auth/sign-up/email')
  await page.waitForFunction(() => !location.pathname.startsWith('/sign-'))
  return email
}

async function sessionCookie(base: string, email: string, password: string) {
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password }),
  })
  if (response.status !== 200) throw new Error(`sign-in status ${response.status}`)
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const cookie = raw
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry.includes('='))
    .join('; ')
  if (!cookie) throw new Error('sign-in cookie missing')
  await response.text().catch(() => '')
  return cookie
}

async function signInBrowser(page: Page, base: string, email: string, password = PASSWORD) {
  await page.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const field = document.getElementById('email')
    if (!field) return false
    return Object.getOwnPropertyNames(field).some((key) => key.startsWith('__reactProps$'))
  })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
  await page.waitForFunction(() => !location.pathname.startsWith('/sign-in'))
}

async function openRowMenu(page: Page, title: string) {
  const row = page.locator('.tree a.it').filter({ hasText: title }).first()
  await row.waitFor()
  const button = row.locator('xpath=following-sibling::button')
  await button.waitFor()
  await page.waitForFunction((name) => {
    const link = [...document.querySelectorAll('.tree a.it')].find((node) =>
      node.textContent.includes(name),
    )
    const control = link?.nextElementSibling
    return (
      control instanceof HTMLButtonElement &&
      Object.getOwnPropertyNames(control).some((key) => key.startsWith('__reactProps'))
    )
  }, title)
  await button.click()
  await page.locator('.menu').filter({ hasText: 'Rename' }).waitFor()
}

async function browserSession() {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(20000)
  return { browser, page }
}

async function renameInTree(page: Page, from: string, to: string) {
  await openRowMenu(page, from)
  await page.locator('.menu').getByRole('button', { name: 'Rename', exact: true }).click()
  const input = page.locator('input[aria-label="Page title"]')
  await input.fill(to)
  await input.press('Enter')
  await page.locator('.tree a.it').filter({ hasText: to }).first().waitFor()
}

async function dialogChecks(prefix: string) {
  const base = baseUrl()
  const { browser, page } = await browserSession()
  try {
    await signUpBrowser(page, base, 'Dialog')
    await page.getByRole('button', { name: '+ New page', exact: true }).last().click()
    await page.getByRole('button', { name: 'Page', exact: true }).click()
    await page.locator('#page-title').waitFor()
    await renameInTree(page, 'Untitled', 'Dialog parent')
    await page.locator('.tree a.it').filter({ hasText: 'Dialog parent' }).first().click()
    await page.getByRole('button', { name: 'Create page', exact: true }).click()
    await page.getByRole('button', { name: 'Page', exact: true }).click()
    await page.waitForFunction((href) => location.href !== href, page.url())
    await page.locator('#page-title').waitFor()
    await renameInTree(page, 'Untitled', 'Dialog child')
    await page.locator('.tree a.it').filter({ hasText: 'Dialog parent' }).first().click()
    await page.waitForFunction(
      () => (document.getElementById('page-title') as HTMLInputElement | null)?.value === 'Dialog parent',
    )
    await page.locator('.page-menu-btn').click()
    const menuText = await page.locator('.menu').innerText()
    const archive = menuText.includes('Archive')
    await page.locator('.menu').getByRole('button', { name: 'Delete page', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    const dialogText = await dialog.innerText()
    const focused = await page.evaluate(() => {
      const active = document.activeElement
      return active ? active.textContent.trim() : ''
    })
    line(`${prefix}_archive_in_menu`, archive)
    line(`${prefix}_shows_title`, dialogText.includes('Dialog parent'))
    line(`${prefix}_shows_count`, dialogText.includes('Its 1 sub-pages'))
    line(`${prefix}_shows_undone`, dialogText.includes("This can't be undone."))
    line(`${prefix}_cancel_focused`, focused === 'Cancel')
    await page.keyboard.press('Enter')
    line(`${prefix}_enter_open`, await dialog.isVisible())
    line(`${prefix}_enter_kept`, await page.locator('.tree a.it').filter({ hasText: 'Dialog parent' }).count())
    await page.keyboard.press('Escape')
    line(`${prefix}_esc_closed`, (await dialog.count()) === 0 || !(await dialog.isVisible()))
    await openRowMenu(page, 'Dialog parent')
    await page.locator('.menu').getByRole('button', { name: 'Delete page', exact: true }).click()
    await dialog.waitFor()
    await page.locator('.delete-modal .scrim').click({ position: { x: 4, y: 4 } })
    const outsideClosed = (await dialog.count()) === 0 || !(await dialog.isVisible())
    line(`${prefix}_outside_closed`, outsideClosed)
    await openRowMenu(page, 'Dialog parent')
    await page.locator('.menu').getByRole('button', { name: 'Delete page', exact: true }).click()
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    line(`${prefix}_cancel_closed`, (await dialog.count()) === 0 || !(await dialog.isVisible()))
    const still = await page.locator('.tree a.it').filter({ hasText: 'Dialog parent' }).count()
    line(`${prefix}_still_there`, still === 1)
    return (
      archive ||
      !dialogText.includes('Dialog parent') ||
      !dialogText.includes('Its 1 sub-pages') ||
      !dialogText.includes("This can't be undone.") ||
      focused !== 'Cancel' ||
      still !== 1 ||
      !outsideClosed
    )
  } finally {
    await browser.close()
  }
}

async function deleteOnce(prefix: string) {
  const base = baseUrl()
  const { browser, page } = await browserSession()
  try {
    await signUpBrowser(page, base, 'Once')
    await page.getByRole('button', { name: '+ New page', exact: true }).last().click()
    await page.getByRole('button', { name: 'Page', exact: true }).click()
    await page.locator('#page-title').waitFor()
    await page.locator('#page-title').fill('Once page')
    await page.locator('#page-title').blur()
    await page.getByText('Saved', { exact: true }).waitFor({ timeout: 10000 }).catch(() => undefined)
    const pageUrl = page.url()
    let posts = 0
    page.on('request', (request) => {
      const body = request.postData() ?? ''
      if (
        request.method() === 'POST' &&
        body.includes('pageId') &&
        !body.includes('"title"') &&
        !body.includes('"body"') &&
        !body.includes('parentId')
      ) {
        posts += 1
      }
    })
    await page.locator('.page-menu-btn').click()
    await page.locator('.menu').getByRole('button', { name: 'Delete page', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).dblclick()
    await page.getByText('Page deleted.', { exact: true }).waitFor()
    await page.waitForURL((url) => url.href !== pageUrl)
    line(`${prefix}_posts`, posts)
    line(`${prefix}_left_page`, !page.url().includes('/p/'))
    line(`${prefix}_toast`, true)
    return posts !== 1
  } finally {
    await browser.close()
  }
}

async function landing(prefix: string) {
  const base = baseUrl()
  const { browser, page } = await browserSession()
  try {
    await signUpBrowser(page, base, 'Land')
    await page.locator('.app').waitFor()
    await page.waitForURL(/\/s\//)
    const home = page.url().split('?')[0] ?? page.url()
    await page.getByRole('button', { name: '+ New page', exact: true }).last().click()
    await page.getByRole('button', { name: 'Page', exact: true }).click()
    await page.locator('#page-title').fill('Land parent')
    await page.locator('#page-title').blur()
    const parentUrl = page.url()
    await page.getByRole('button', { name: 'Create page', exact: true }).click()
    await page.getByRole('button', { name: 'Page', exact: true }).click()
    await page.waitForFunction((href) => location.href !== href, parentUrl)
    await page.locator('#page-title').fill('Land child')
    await page.locator('#page-title').blur()
    await page.locator('.page-menu-btn').click()
    await page.locator('.menu').getByRole('button', { name: 'Delete page', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByText('Page deleted.', { exact: true }).waitFor()
    await page.waitForURL(parentUrl)
    line(`${prefix}_child_to_parent`, page.url() === parentUrl)
    await page.locator('.page-menu-btn').click()
    await page.locator('.menu').getByRole('button', { name: 'Delete page', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForURL((url) => url.href.split('?')[0] === home)
    line(`${prefix}_root_to_home`, (page.url().split('?')[0] ?? page.url()) === home)
    line(`${prefix}_toast`, await page.getByText('Page deleted.', { exact: true }).isVisible())
    return page.url() !== home
  } finally {
    await browser.close()
  }
}

async function otherEditor(app: App, prefix: string) {
  const base = baseUrl()
  const { owner, member, spaceId } = await roster(app, 'Fc12')
  const pageRow = await app.createPage(owner.user.id, { spaceId, title: 'Shared twelve' })
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  try {
    const email = member.user.email
    await signInBrowser(page, base, email, LIBRARY_PASSWORD)
    await page.goto(`${base}/s/${spaceId}/p/${pageRow.id}`, { waitUntil: 'domcontentloaded' })
    await page.locator('#page-title').waitFor()
    await page.waitForFunction(() => {
      const button = document.querySelector('.mode-switch button')
      if (!button) return false
      return Object.getOwnPropertyNames(button).some((key) => key.startsWith('__reactProps'))
    })
    await page.locator('.mode-switch').getByRole('radio', { name: 'Edit', exact: true }).click()
    await page.locator('.editing-chip').waitFor()
    await app.archivePage(owner.user.id, pageRow.id)
    let saveStatus = 0
    page.on('response', (response) => {
      const request = response.request()
      if (request.method() !== 'POST') return
      const body = request.postData() ?? ''
      if (body.includes(pageRow.id) && body.includes('title')) saveStatus = response.status()
    })
    await page.locator('.doc-editor').click()
    await page.locator('.doc-editor').pressSequentially('should not store')
    const heading = page.getByRole('heading', { name: 'This page was deleted.' })
    const seen = await heading.waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
    const stored = await app.getPageView(owner.user.id, pageRow.id).catch(() => null)
    line(`${prefix}_heading`, seen)
    line(`${prefix}_save_status`, saveStatus)
    line(`${prefix}_stored`, stored !== null)
    return !seen || saveStatus !== 404 || stored !== null
  } finally {
    await browser.close()
  }
}

async function deletedDrawing(app: App, prefix: string) {
  const base = baseUrl()
  const owner = await app.createUser('Fc13')
  const source = await app.createPage(owner.user.id, { spaceId: owner.space.id, title: 'Source thirteen' })
  const diagram = await app.createDiagram(owner.user.id, source.id)
  const dest = await app.createPage(owner.user.id, { spaceId: owner.space.id, title: 'Dest thirteen' })
  const body = JSON.stringify({
    type: 'doc',
    content: [{ type: 'diagram', attrs: { drawingId: diagram.id } }],
  })
  await app.getSql().unsafe('update page set body = $1::jsonb where id = $2', [body, dest.id])
  await app.archivePage(owner.user.id, source.id)
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(20000)
  let saves = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const url = request.url()
    const data = request.postData() ?? ''
    if (url.includes('/api/pages/save') || url.includes('/api/drawings') || data.includes('cloneDiagram')) {
      saves += 1
    }
  })
  try {
    await signInBrowser(page, base, owner.user.email, LIBRARY_PASSWORD)
    await page.goto(`${base}/s/${owner.space.id}/p/${dest.id}`, { waitUntil: 'domcontentloaded' })
    await page.getByText('This drawing was deleted.', { exact: true }).waitFor()
    const box = await page.locator('.diagram-deleted').boundingBox()
    const buttons = await page.locator('.diagram-block button').count()
    await page.getByRole('radio', { name: 'Edit', exact: true }).click()
    await page.waitForTimeout(1200)
    line(`${prefix}_frame`, true)
    line(`${prefix}_buttons`, buttons)
    line(`${prefix}_height`, Math.round(box?.height ?? 0))
    line(`${prefix}_saves`, saves)
    return buttons !== 0 || saves !== 0 || (box?.height ?? 0) < 40
  } finally {
    await browser.close()
  }
}

async function failedDelete(prefix: string) {
  const base = baseUrl()
  const { browser, page } = await browserSession()
  try {
    await signUpBrowser(page, base, 'Retry')
    await page.getByRole('button', { name: '+ New page', exact: true }).last().click()
    await page.getByRole('button', { name: 'Page', exact: true }).click()
    await page.locator('#page-title').fill('Retry page')
    await page.locator('#page-title').blur()
    await page.locator('.page-menu-btn').click()
    await page.locator('.menu').getByRole('button', { name: 'Delete page', exact: true }).click()
    let failed = false
    await page.route(/_serverFn|serverFn/, async (route) => {
      const body = route.request().postData() ?? ''
      if (!failed && route.request().method() === 'POST' && body.includes('pageId') && !body.includes('"title"') && !body.includes('"body"')) {
        failed = true
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' })
        return
      }
      await route.continue()
    })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await dialog.getByText("Couldn't delete this page.").waitFor()
    const stillOpen = await dialog.isVisible()
    const retry = await dialog.getByRole('button', { name: 'Delete', exact: true }).isEnabled()
    line(`${prefix}_stayed_open`, stillOpen)
    line(`${prefix}_retry_enabled`, retry)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByText('Page deleted.', { exact: true }).waitFor()
    line(`${prefix}_retried`, true)
    return !stillOpen || !retry
  } finally {
    await browser.close()
  }
}

async function menus(app: App, prefix: string) {
  const base = baseUrl()
  const { owner, member, spaceId } = await roster(app, 'Fc20')
  const owned = await app.createPage(owner.user.id, { spaceId, title: 'Menu owned' })
  await app.createPage(member.user.id, { spaceId, title: 'Menu made' })
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const ownerPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    ownerPage.setDefaultTimeout(20000)
    await signInBrowser(ownerPage, base, owner.user.email, LIBRARY_PASSWORD)
    await ownerPage.goto(`${base}/s/${spaceId}/p/${owned.id}`, { waitUntil: 'domcontentloaded' })
    await ownerPage.locator('#page-title').waitFor()
    await ownerPage.locator('.tree a.it').filter({ hasText: 'Menu made' }).waitFor()
    await openRowMenu(ownerPage, 'Menu made')
    const ownerRow = await ownerPage.locator('.menu').innerText()
    await ownerPage.locator('.page-menu-btn').click()
    const ownerPageMenu = await ownerPage.locator('.page-menu .menu').innerText()
    const memberPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    memberPage.setDefaultTimeout(20000)
    await signInBrowser(memberPage, base, member.user.email, LIBRARY_PASSWORD)
    await memberPage.goto(`${base}/s/${spaceId}/p/${owned.id}`, { waitUntil: 'domcontentloaded' })
    await memberPage.locator('#page-title').waitFor()
    await openRowMenu(memberPage, 'Menu owned')
    const memberRow = await memberPage.locator('.menu').innerText()
    await memberPage.locator('.page-menu-btn').click()
    const memberPageMenu = await memberPage.locator('.page-menu .menu').innerText()
    const archive =
      ownerRow.includes('Archive') ||
      ownerPageMenu.includes('Archive') ||
      memberRow.includes('Archive') ||
      memberPageMenu.includes('Archive')
    const memberDelete = memberRow.includes('Delete page') || memberPageMenu.includes('Delete page')
    const ownerDelete = ownerRow.includes('Delete page') && ownerPageMenu.includes('Delete page')
    line(`${prefix}_archive`, archive)
    line(`${prefix}_member_delete`, memberDelete)
    line(`${prefix}_owner_delete`, ownerDelete)
    return archive || memberDelete || !ownerDelete
  } finally {
    await browser.close()
  }
}

async function sourceBug(which: string) {
  if (which === 'fc4') {
    return !pinIncludes('src/components/DeletePageDialog.tsx', "This can't be undone.")
  }
  if (which === 'fc10') {
    const frame = pinText('src/components/AppFrame.tsx')
    return !frame.includes('dblclick') && frame.includes('archivePageFn')
  }
  if (which === 'fc11') {
    return !pinIncludes('src/components/AppFrame.tsx', 'Page deleted.')
  }
  if (which === 'fc12') {
    return !pinIncludes('src/components/PageEditor.tsx', 'This page was deleted.')
  }
  if (which === 'fc13') {
    return (
      pinIncludes('src/components/DiagramView.tsx', 'Drawing unavailable') &&
      !pinIncludes('src/components/DiagramView.tsx', 'This drawing was deleted.')
    )
  }
  if (which === 'fc15') {
    return !pinIncludes('src/components/DeletePageDialog.tsx', "Couldn't delete this page.")
  }
  if (which === 'fc20') {
    return (
      pinIncludes('src/components/PageTree.tsx', 'Archive') &&
      !pinIncludes('src/components/PageTree.tsx', 'Delete page')
    )
  }
  return false
}

const COVERAGE_IDS = Array.from({ length: 20 }, (_, index) => index + 1)

function hasCoverageStep(text: string, id: number) {
  return new RegExp(`44-fc${id}(?!\\d)`).test(text)
}

function coverageBug(planted: boolean) {
  const verifyAll = planted
    ? pinText('scripts/verify-all.sh')
    : readFileSync(join(repoRoot, 'scripts/verify-all.sh'), 'utf8')
  const recipes = planted
    ? pinText('scripts/verify-fail-conditions.sh')
    : readFileSync(join(repoRoot, 'scripts/verify-fail-conditions.sh'), 'utf8')
  return COVERAGE_IDS.some(
    (id) => !hasCoverageStep(verifyAll, id) || !hasCoverageStep(recipes, id),
  )
}

async function run(which: string, planted: boolean) {
  const prefix = `44_${which}_${planted ? 'planted' : 'head'}`
  line(`${prefix}_pin`, PIN)
  if (which === 'fc9') {
    const bug = coverageBug(planted)
    line(`${prefix}_complete`, !bug)
    return bug
  }
  if (planted && ['fc4', 'fc10', 'fc11', 'fc12', 'fc13', 'fc15', 'fc20'].includes(which)) {
    const bug = await sourceBug(which)
    line(`${prefix}_bug`, bug)
    return bug
  }
  databaseUrl()
  ensureAuthEnv()
  const root = planted ? await materializePin() : repoRoot
  const app = await loadApp(root)
  try {
    if (which === 'fc1') return await fc1(app, prefix)
    if (which === 'fc2') return await fc2(app, prefix)
    if (which === 'fc3') {
      const dialogBug = planted ? false : await dialogChecks(`${prefix}_ui`)
      return await fc3(app, prefix, !dialogBug)
    }
    if (which === 'fc4') return await dialogChecks(prefix)
    if (which === 'fc5') return await fc5(app, prefix)
    if (which === 'fc6') return await fc6(app, prefix)
    if (which === 'fc7') return await fc7(app, prefix)
    if (which === 'fc8') return await fc8(app, prefix)
    if (which === 'fc10') return await deleteOnce(prefix)
    if (which === 'fc11') return await landing(prefix)
    if (which === 'fc12') return await otherEditor(app, prefix)
    if (which === 'fc13') return await deletedDrawing(app, prefix)
    if (which === 'fc14') return await fc14(app, prefix)
    if (which === 'fc15') return await failedDelete(prefix)
    if (which === 'fc16') return await fc16(app, prefix)
    if (which === 'fc17') return await fc17(app, prefix)
    if (which === 'fc18') return await fc18(app, prefix)
    if (which === 'fc19') return await fc19(app, prefix)
    if (which === 'fc20') return await menus(app, prefix)
    throw new Error(`unknown ${which}`)
  } finally {
    await app.closeDb().catch(() => undefined)
    if (planted && root !== repoRoot) rmSync(root, { recursive: true, force: true })
  }
}

const mode = process.argv[2] ?? ''
const planted = mode.endsWith('-planted')
const which = mode.replace(/-planted$/, '')

if (!/^fc(?:[1-9]|1\d|20)$/.test(which)) {
  console.error('usage: issue44-fail.ts fc1..fc20[-planted]')
  process.exit(2)
}

run(which, planted)
  .then((bug) => {
    process.exit(bug ? 1 : 0)
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'issue44 failed'
    const cause =
      error instanceof Error && 'cause' in error ? error.cause : undefined
    const causeRecord =
      cause && typeof cause === 'object'
        ? (cause as { code?: unknown; message?: unknown; routine?: unknown })
        : undefined
    const detail = causeRecord
      ? `code=${String(causeRecord.code ?? '')} routine=${String(causeRecord.routine ?? '')}`
      : `cause_type=${typeof cause}`
    const lineText = redact(message.split('\n')[0] ?? '')
    if (lineText) console.error(lineText)
    if (detail.startsWith('code=') && !detail.startsWith('code= routine=')) {
      console.error(detail)
    }
    process.exit(1)
  })
