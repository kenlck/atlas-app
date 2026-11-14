import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import type { Json } from '../src/lib/body-text.ts'
import { rejectEverySave } from './fixtures/issue50-save.ts'
import {
  assertLocalBaseUrl,
  assertLocalDatabaseUrl,
  enterEdit,
  submitAuthForm,
} from './verify-local.ts'

const PIN = '34a6d03235abd5bae4921c94e86ebd687fb3eb8c'
const repoRoot = join(import.meta.dirname, '..')
const ALICE = 'base + ALICE PARAGRAPH'
const BOB = 'base + bob typo fix'

type Person = {
  user: { id: string }
  password: string
}

type View = {
  id: string
  updatedAt: string
  body: Json
  spaceId: string
}

type App = {
  createPage: (
    userId: string,
    input: { spaceId: string; title?: string },
  ) => Promise<View>
  savePage: (
    userId: string,
    input: { pageId: string; title: string; body: Json },
  ) => Promise<View>
  getPageView: (userId: string, pageId: string) => Promise<View>
  createUser: (name?: string) => Promise<Person & { space: { id: string } }>
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
  closeDb: () => Promise<void>
}

function line(name: string, value: string | number | boolean) {
  console.log(`${name}=${value}`)
}

function redact(text: string) {
  return text
    .replace(/atl_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[redacted-host]')
    .split('\n')[0]
    .slice(0, 160)
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
    process.env.BETTER_AUTH_SECRET = 'issue50-fail-secret-not-a-credential'
  }
  if (!process.env.BETTER_AUTH_URL) {
    process.env.BETTER_AUTH_URL =
      process.env.BASE_URL || 'http://127.0.0.1:3000'
  }
}

function doc(text: string): Json {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function winner(body: unknown) {
  const text = JSON.stringify(body)
  const alice = text.includes('ALICE PARAGRAPH')
  const bob = text.includes('bob typo')
  if (alice && !bob) return 'alice'
  if (bob && !alice) return 'bob'
  return 'other'
}

function sliceFn(source: string, startMark: string, endMark: string) {
  const start = source.indexOf(startMark)
  if (start < 0) return ''
  const end = source.indexOf(endMark, start + startMark.length)
  return source.slice(start, end < 0 ? undefined : end)
}

function pinText(path: string) {
  return execFileSync('git', ['show', `${PIN}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function materializePin() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-50-'))
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
  const db = (await import(href('src/lib/db.ts'))) as Pick<App, 'closeDb'>
  return {
    createPage: pages.createPage,
    savePage: pages.savePage,
    getPageView: pages.getPageView,
    createUser: helpers.createUser,
    createTeam: teams.createTeam,
    createInvite: teams.createInvite,
    acceptInvite: teams.acceptInvite,
    closeDb: db.closeDb,
  }
}

async function withApp<T>(root: string, task: (app: App) => Promise<T>) {
  const app = await loadApp(root)
  try {
    return await task(app)
  } finally {
    await app.closeDb().catch(() => undefined)
    if (root !== repoRoot) rmSync(root, { recursive: true, force: true })
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
  const owner = await app.createUser('Ada')
  const member = await app.createUser('Bob')
  const team = await app.createTeam(owner.user.id, 'Notes')
  const invite = await app.createInvite(owner.user.id, team.id, member.user.id)
  await app.acceptInvite(member.user.id, invite.id)
  return { owner, member, spaceId: team.spaceId }
}

async function overwrite(app: App, label: 'server' | 'api') {
  const { owner, member, spaceId } = await roster(app)
  const made = await app.createPage(owner.user.id, { spaceId, title: 'Shared' })
  await app.savePage(owner.user.id, {
    pageId: made.id,
    title: 'Shared',
    body: doc('base'),
  })
  const alice = await statusOf(() =>
    app.savePage(owner.user.id, {
      pageId: made.id,
      title: 'Shared',
      body: doc(ALICE),
    }),
  )
  const bob = await statusOf(() =>
    app.savePage(member.user.id, {
      pageId: made.id,
      title: 'Shared',
      body: doc(BOB),
    }),
  )
  const stored = await app.getPageView(owner.user.id, made.id)
  line(`50_fc1_planted_${label}_alice`, alice)
  line(`50_fc1_planted_${label}_status`, bob)
  line(`50_fc1_planted_${label}_stored`, winner(stored.body))
  return alice === 200 && bob === 200 && winner(stored.body) === 'bob'
}

function plantedSources() {
  const pages = sliceFn(
    pinText('src/lib/pages.ts'),
    'export async function savePage(',
    '\nexport async function movePage(',
  )
  const serverFn = sliceFn(
    pinText('src/server/fns.ts'),
    'export const savePageFn',
    '\nexport const ',
  )
  const api = sliceFn(
    pinText('src/lib/page-save-request.ts'),
    'export async function handlePageSave',
    '\nexport ',
  )
  const serverUnversioned =
    serverFn.length > 0 && !serverFn.includes('updatedAt')
  const apiUnversioned = api.length > 0 && !api.includes('updatedAt')
  const writeUnversioned = pages.includes(
    'writeDocBody(userId, input.pageId, title, input.body, null, null)',
  )
  line('50_fc1_planted_pin', PIN)
  line(
    '50_fc1_planted_server_fn_unversioned',
    serverUnversioned && writeUnversioned,
  )
  line('50_fc1_planted_api_unversioned', apiUnversioned && writeUnversioned)
  return serverUnversioned && apiUnversioned && writeUnversioned
}

async function fc1Planted() {
  databaseUrl()
  ensureAuthEnv()
  const sources = plantedSources()
  const root = await materializePin()
  const overwrote = await withApp(root, async (app) => {
    const server = await overwrite(app, 'server')
    const api = await overwrite(app, 'api')
    return server && api
  })
  return sources && overwrote
}

async function freshPair(app: App, texts: [string, string]) {
  const owner = await app.createUser('Ada')
  const made = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Notes',
  })
  const first = await statusOf(() =>
    app.savePage(owner.user.id, {
      pageId: made.id,
      title: 'Notes',
      body: doc(texts[0]),
    }),
  )
  const second = await statusOf(() =>
    app.savePage(owner.user.id, {
      pageId: made.id,
      title: 'Notes',
      body: doc(texts[1]),
    }),
  )
  const stored = await app.getPageView(owner.user.id, made.id)
  return {
    first,
    second,
    kept: JSON.stringify(stored.body).includes(texts[1]),
  }
}

async function fc2Planted() {
  databaseUrl()
  ensureAuthEnv()
  const plain = await materializePin()
  const pinOk = await withApp(plain, async (app) => {
    const saved = await freshPair(app, ['one', 'two'])
    return saved.first === 200 && saved.second === 200 && saved.kept
  })
  line('50_fc2_planted_pin_ok', pinOk)
  if (!pinOk) throw new Error('pin already rejected a fresh save')
  const tight = await materializePin()
  const path = join(tight, 'src/lib/pages.ts')
  writeFileSync(path, rejectEverySave(readFileSync(path, 'utf8')))
  const rejected = await withApp(tight, async (app) => {
    const owner = await app.createUser('Ada')
    const made = await app.createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Notes',
    })
    const status = await statusOf(() =>
      app.savePage(owner.user.id, {
        pageId: made.id,
        title: 'Notes',
        body: doc('fresh'),
      }),
    )
    const stored = await app.getPageView(owner.user.id, made.id)
    const kept = JSON.stringify(stored.body).includes('fresh')
    return { status, kept }
  })
  const status = rejected.status
  const kept = rejected.kept
  line('50_fc2_planted_fixture', 'reject-save')
  line('50_fc2_planted_status', status)
  line('50_fc2_planted_stored', kept)
  return status === 409 && !kept
}

function fc3Planted() {
  const editor = pinText('src/components/PageEditor.tsx')
  const banner = editor.includes(
    'Someone else changed this page since you opened it.',
  )
  line('50_fc3_planted_pin', PIN)
  line('50_fc3_planted_banner', banner)
  return !banner
}

function cookieHeader(response: Response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []
  return raw
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry.includes('='))
    .join('; ')
}

async function signUp(base: string, name: string) {
  const email = `${name}.${crypto.randomUUID()}@example.com`.toLowerCase()
  const password = `pw-${crypto.randomUUID()}`
  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name, email, password }),
    })
    if (response.status !== 429) break
    await response.text().catch(() => '')
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  if (!response) throw new Error('sign-up missing response')
  const text = await response.text()
  if (response.status !== 200) throw new Error('sign-up failed')
  const cookie = cookieHeader(response)
  if (!cookie) throw new Error('sign-up cookie missing')
  const body = JSON.parse(text) as { user?: { id?: string } }
  if (!body.user?.id) throw new Error('sign-up user missing')
  return { cookie, email, password, userId: body.user.id }
}

function serverFnPayload(data: unknown) {
  let next = 0
  const node = (value: unknown): unknown => {
    if (value === null) return { t: 2, s: 0 }
    if (typeof value === 'string') return { t: 1, s: value }
    if (typeof value === 'boolean') return { t: value ? 4 : 3, s: 0 }
    if (Array.isArray(value)) {
      const id = next
      next += 1
      return { t: 9, i: id, a: value.map((item) => node(item)), o: 0 }
    }
    if (typeof value === 'object') {
      const id = next
      next += 1
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
      return {
        t: 10,
        i: id,
        p: { k: keys, v: keys.map((key) => node(record[key])) },
        o: 0,
      }
    }
    throw new Error('unsupported server function value')
  }
  return { t: node(data), f: 127, m: [] as unknown[] }
}

async function serverFnId() {
  const dir = join(repoRoot, '.output/server/_ssr')
  const files = (await readdir(dir)).filter(
    (file) => file.startsWith('fns-') && file.endsWith('.mjs'),
  )
  const pattern =
    /var savePageFn = createServerFn\(\{ method: "POST" \}\)[\s\S]*?createSsrRpc\("([a-f0-9]{64})"\)/
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    const match = pattern.exec(text)
    if (match?.[1]) return match[1]
  }
  throw new Error('savePageFn id missing')
}

async function callSaveFn(
  base: string,
  cookie: string,
  id: string,
  data: Record<string, unknown>,
) {
  const response = await fetch(`${base}/_serverFn/${id}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'content-type': 'application/json',
      'x-tsr-serverFn': 'true',
    },
    body: JSON.stringify(serverFnPayload({ data })),
  })
  await response.text()
  return response.status
}

async function callSaveApi(
  base: string,
  cookie: string,
  data: Record<string, unknown>,
) {
  const response = await fetch(`${base}/api/pages/save`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'content-type': 'application/json',
    },
    body: JSON.stringify(data),
  })
  const text = await response.text()
  return {
    status: response.status,
    updatedAt: response.headers.get('x-updated-at') ?? '',
    empty: text.length === 0,
  }
}

async function headApp() {
  databaseUrl()
  ensureAuthEnv()
  return loadApp(repoRoot)
}

async function teamPage(app: App, ownerId: string, memberId: string) {
  const team = await app.createTeam(ownerId, 'Notes')
  const invite = await app.createInvite(ownerId, team.id, memberId)
  await app.acceptInvite(memberId, invite.id)
  const made = await app.createPage(ownerId, {
    spaceId: team.spaceId,
    title: 'Shared',
  })
  return made
}

async function fc1Head() {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const app = await headApp()
  try {
    const fn = await serverFnId()
    const ada = await signUp(base, 'Ada')
    const bob = await signUp(base, 'Bob')
    const serverPage = await teamPage(app, ada.userId, bob.userId)
    const baseSave = await callSaveFn(base, ada.cookie, fn, {
      pageId: serverPage.id,
      title: 'Shared',
      body: doc('base'),
      updatedAt: serverPage.updatedAt,
    })
    if (baseSave !== 200) throw new Error('server base save failed')
    const loaded = await app.getPageView(ada.userId, serverPage.id)
    const alice = await callSaveFn(base, ada.cookie, fn, {
      pageId: serverPage.id,
      title: 'Shared',
      body: doc(ALICE),
      updatedAt: loaded.updatedAt,
    })
    const stale = await callSaveFn(base, bob.cookie, fn, {
      pageId: serverPage.id,
      title: 'Shared',
      body: doc(BOB),
      updatedAt: loaded.updatedAt,
    })
    const stored = await app.getPageView(ada.userId, serverPage.id)
    line('50_fc1_head_server_alice', alice)
    line('50_fc1_head_server_bob', stale)
    line('50_fc1_head_server_stored', winner(stored.body))
    const missing = await callSaveFn(base, ada.cookie, fn, {
      pageId: serverPage.id,
      title: 'Shared',
      body: doc('no stamp'),
    })
    const afterMissing = await app.getPageView(ada.userId, serverPage.id)
    line('50_fc1_head_server_missing', missing)
    line(
      '50_fc1_head_server_missing_unchanged',
      winner(afterMissing.body) === 'alice' &&
        afterMissing.updatedAt === stored.updatedAt,
    )

    const apiPage = await teamPage(app, ada.userId, bob.userId)
    const apiBase = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Shared',
      body: doc('base'),
      updatedAt: apiPage.updatedAt,
    })
    if (apiBase.status !== 204 || !apiBase.updatedAt)
      throw new Error('api base save failed')
    const apiAlice = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Shared',
      body: doc(ALICE),
      updatedAt: apiBase.updatedAt,
    })
    const apiBob = await callSaveApi(base, bob.cookie, {
      pageId: apiPage.id,
      title: 'Shared',
      body: doc(BOB),
      updatedAt: apiBase.updatedAt,
    })
    const apiStored = await app.getPageView(ada.userId, apiPage.id)
    line('50_fc1_head_api_alice', apiAlice.status)
    line('50_fc1_head_api_bob', apiBob.status)
    line('50_fc1_head_api_stored', winner(apiStored.body))
    const apiMissing = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Shared',
      body: doc('no stamp'),
    })
    const apiAfter = await app.getPageView(ada.userId, apiPage.id)
    line('50_fc1_head_api_missing', apiMissing.status)
    line(
      '50_fc1_head_api_missing_unchanged',
      winner(apiAfter.body) === 'alice' &&
        apiAfter.updatedAt === apiStored.updatedAt,
    )
    return (
      alice === 200 &&
      stale === 409 &&
      winner(stored.body) === 'alice' &&
      missing === 400 &&
      winner(afterMissing.body) === 'alice' &&
      apiAlice.status === 204 &&
      apiBob.status === 409 &&
      winner(apiStored.body) === 'alice' &&
      apiMissing.status === 400 &&
      winner(apiAfter.body) === 'alice'
    )
  } finally {
    await app.closeDb().catch(() => undefined)
  }
}

async function fc2Head() {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const app = await headApp()
  try {
    const fn = await serverFnId()
    const ada = await signUp(base, 'Ada')
    const made = await app.createPage(ada.userId, {
      spaceId: (await app.createTeam(ada.userId, 'Solo')).spaceId,
      title: 'Notes',
    })
    const first = await callSaveFn(base, ada.cookie, fn, {
      pageId: made.id,
      title: 'Notes',
      body: doc('one'),
      updatedAt: made.updatedAt,
    })
    const mid = await app.getPageView(ada.userId, made.id)
    const second = await callSaveFn(base, ada.cookie, fn, {
      pageId: made.id,
      title: 'Notes',
      body: doc('two'),
      updatedAt: mid.updatedAt,
    })
    const stored = await app.getPageView(ada.userId, made.id)
    const serverKept = JSON.stringify(stored.body).includes('two')
    line('50_fc2_head_server_first', first)
    line('50_fc2_head_server_second', second)
    line('50_fc2_head_server_stored', serverKept)

    const apiPage = await app.createPage(ada.userId, {
      spaceId: made.spaceId,
      title: 'Notes api',
    })
    const apiFirst = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Notes api',
      body: doc('one'),
      updatedAt: apiPage.updatedAt,
    })
    const apiSecond = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Notes api',
      body: doc('two'),
      updatedAt: apiFirst.updatedAt,
    })
    const apiStored = await app.getPageView(ada.userId, apiPage.id)
    const apiKept = JSON.stringify(apiStored.body).includes('two')
    line('50_fc2_head_api_first', apiFirst.status)
    line('50_fc2_head_api_second', apiSecond.status)
    line('50_fc2_head_api_stored', apiKept)
    line(
      '50_fc2_head_api_header',
      apiSecond.updatedAt === apiStored.updatedAt && apiSecond.empty,
    )

    const inflight = await inflightSave(base, ada, app)
    return (
      first === 200 &&
      second === 200 &&
      serverKept &&
      apiFirst.status === 204 &&
      apiSecond.status === 204 &&
      apiKept &&
      apiSecond.updatedAt === apiStored.updatedAt &&
      inflight
    )
  } finally {
    await app.closeDb().catch(() => undefined)
  }
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
      key.startsWith('__reactProps'),
    )
  })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await submitAuthForm(page, 'Sign in', '/api/auth/sign-in/email')
  await page.waitForFunction(() => !location.pathname.startsWith('/sign-in'))
}

async function inflightSave(
  base: string,
  ada: { email: string; password: string; userId: string },
  app: App,
) {
  const made = await app.createPage(ada.userId, {
    spaceId: (await app.createTeam(ada.userId, 'Queue')).spaceId,
    title: 'Queue',
  })
  const loaded = made.updatedAt
  const marker = `v50${crypto.randomUUID().slice(0, 8)}`
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  let releaseFirst = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let markHeld = () => {}
  const held = new Promise<void>((resolve) => {
    markHeld = resolve
  })
  let markSecond = (_value: { body: string; status: number }) => {}
  const second = new Promise<{ body: string; status: number }>((resolve) => {
    markSecond = resolve
  })
  let heldOnce = false
  let firstStatus = 0
  try {
    await page.route(/_serverFn/, async (route) => {
      const request = route.request()
      const post = request.postData() ?? ''
      if (request.method() !== 'POST' || !post.includes(marker)) {
        await route.continue()
        return
      }
      if (post.includes(' BETA')) {
        const response = await route.fetch()
        markSecond({ body: post, status: response.status() })
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body: await response.body(),
        })
        return
      }
      if (heldOnce) {
        await route.continue()
        return
      }
      heldOnce = true
      const response = await route.fetch()
      firstStatus = response.status()
      markHeld()
      await gate
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: await response.body(),
      })
    })
    await signIn(page, base, ada.email, ada.password)
    await page.goto(`${base}/s/${made.spaceId}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.locator('#page-title').waitFor()
    await enterEdit(page)
    await page.locator('.doc-editor').click()
    await page.keyboard.type(marker)
    await Promise.race([
      held,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('first save was not held')), 8000),
      ),
    ])
    const fresh = await app.getPageView(ada.userId, made.id)
    await page.keyboard.type(' BETA')
    await page.waitForTimeout(1000)
    releaseFirst()
    const next = await Promise.race([
      second,
      new Promise<{ body: string; status: number }>((_, reject) =>
        setTimeout(() => reject(new Error('queued save was not sent')), 8000),
      ),
    ])
    const match =
      next.body.includes(fresh.updatedAt) && !next.body.includes(loaded)
    line('50_fc2_head_inflight_match', match)
    line('50_fc2_head_inflight_status', next.status)
    line('50_fc2_head_inflight_first', firstStatus)
    return (
      match &&
      next.status === 200 &&
      firstStatus === 200 &&
      fresh.updatedAt !== loaded
    )
  } finally {
    await browser.close()
  }
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
  line('50_fc3_head_screenshot', name)
}

async function fc3Head() {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const app = await headApp()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  })
  try {
    const ada = await signUp(base, 'Ada')
    const bob = await signUp(base, 'Bob')
    const made = await teamPage(app, ada.userId, bob.userId)
    const opened = await callSaveApi(base, ada.cookie, {
      pageId: made.id,
      title: 'Shared',
      body: doc('base'),
      updatedAt: made.updatedAt,
    })
    if (opened.status !== 204) throw new Error('base save failed')
    await signIn(page, base, ada.email, ada.password)
    await page.goto(`${base}/s/${made.spaceId}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.locator('#page-title').waitFor()
    const loaded = await app.getPageView(ada.userId, made.id)
    const other = await callSaveApi(base, bob.cookie, {
      pageId: made.id,
      title: 'Shared',
      body: doc('base + BOB PARAGRAPH'),
      updatedAt: loaded.updatedAt,
    })
    if (other.status !== 204) throw new Error('other save failed')
    await enterEdit(page)
    const marker = `keep50${crypto.randomUUID().slice(0, 8)}`
    await page.locator('.doc-editor').click()
    await page.keyboard.type(marker)
    const banner = page.locator('.retry')
    await banner.waitFor({ timeout: 8000 })
    const text = (await banner.innerText()).replace(/\s+/g, ' ').trim()
    const colors = await banner.evaluate((el) => {
      const style = getComputedStyle(el)
      return { background: style.backgroundColor, color: style.color }
    })
    const reload = await page.getByRole('button', { name: 'Reload' }).count()
    const retry = await page.getByRole('button', { name: 'Retry' }).count()
    const editable = await page
      .locator('.doc-editor')
      .getAttribute('contenteditable')
    const titleLocked =
      (await page.locator('#page-title').getAttribute('readonly')) !== null
    const visible = (await page.locator('.doc-editor').innerText()).includes(
      marker,
    )
    const stored = await app.getPageView(ada.userId, made.id)
    const storedText = JSON.stringify(stored.body)
    await shot(page, '50-fc3-conflict-1280.png')
    await page.setViewportSize({ width: 390, height: 800 })
    await shot(page, '50-fc3-conflict-390.png')
    const shown =
      text === 'Someone else changed this page since you opened it. Reload' &&
      colors.background === 'rgb(254, 243, 242)' &&
      colors.color === 'rgb(180, 35, 24)'
    line('50_fc3_head_banner', shown)
    line('50_fc3_head_reload', reload)
    line('50_fc3_head_retry', retry)
    line('50_fc3_head_readonly', editable === 'false' && titleLocked)
    line('50_fc3_head_text_visible', visible)
    line('50_fc3_head_stored', storedText.includes(marker))
    line('50_fc3_head_other_kept', storedText.includes('BOB PARAGRAPH'))
    return (
      shown &&
      reload === 1 &&
      retry === 0 &&
      editable === 'false' &&
      titleLocked &&
      visible &&
      !storedText.includes(marker) &&
      storedText.includes('BOB PARAGRAPH')
    )
  } finally {
    await browser.close()
    await app.closeDb().catch(() => undefined)
  }
}

const mode = process.argv[2]
try {
  if (mode === 'fc1-planted') {
    const bug = await fc1Planted()
    process.exit(bug ? 1 : 0)
  } else if (mode === 'fc1') {
    const ok = await fc1Head()
    process.exit(ok ? 0 : 1)
  } else if (mode === 'fc2-planted') {
    const bug = await fc2Planted()
    process.exit(bug ? 1 : 0)
  } else if (mode === 'fc2') {
    const ok = await fc2Head()
    process.exit(ok ? 0 : 1)
  } else if (mode === 'fc3-planted') {
    const bug = fc3Planted()
    process.exit(bug ? 1 : 0)
  } else if (mode === 'fc3') {
    const ok = await fc3Head()
    process.exit(ok ? 0 : 1)
  } else {
    throw new Error('usage')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'failed'
  line('50_error', redact(message))
  process.exit(1)
}
