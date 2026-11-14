import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
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
    input: { pageId: string; title: string; body: Json; updatedAt?: string },
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

function materializePin(sha = PIN) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-50-'))
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

async function parallelLibrary(app: App) {
  const owner = await app.createUser('Ada')
  const made = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Race',
  })
  await app.savePage(owner.user.id, {
    pageId: made.id,
    title: 'Race',
    body: doc('base'),
  })
  const loaded = await app.getPageView(owner.user.id, made.id)
  const [left, right] = await Promise.all([
    statusOf(() =>
      app.savePage(owner.user.id, {
        pageId: made.id,
        title: 'Race',
        body: doc('RACE LEFT'),
        updatedAt: loaded.updatedAt,
      }),
    ),
    statusOf(() =>
      app.savePage(owner.user.id, {
        pageId: made.id,
        title: 'Race',
        body: doc('RACE RIGHT'),
        updatedAt: loaded.updatedAt,
      }),
    ),
  ])
  const stored = JSON.stringify((await app.getPageView(owner.user.id, made.id)).body)
  const wins = [left, right].filter((status) => status === 200).length
  const conflicts = [left, right].filter((status) => status === 409).length
  const leftKept = stored.includes('RACE LEFT')
  const rightKept = stored.includes('RACE RIGHT')
  return { wins, conflicts, kept: leftKept !== rightKept }
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
  const raceRoot = await materializePin()
  const raced = await withApp(raceRoot, async (app) => {
    const race = await parallelLibrary(app)
    line('50_fc1_planted_race_wins', race.wins)
    line('50_fc1_planted_race_conflicts', race.conflicts)
    line('50_fc1_planted_race_stored', race.kept)
    return race.wins !== 1 || race.conflicts !== 1
  })
  return sources && overwrote && raced
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

    const racePage = await app.createPage(ada.userId, {
      spaceId: serverPage.spaceId,
      title: 'Race',
    })
    const raceBase = await callSaveFn(base, ada.cookie, fn, {
      pageId: racePage.id,
      title: 'Race',
      body: doc('base'),
      updatedAt: racePage.updatedAt,
    })
    if (raceBase !== 200) throw new Error('race base save failed')
    const raceLoaded = await app.getPageView(ada.userId, racePage.id)
    const [raceLeft, raceRight] = await Promise.all([
      callSaveFn(base, ada.cookie, fn, {
        pageId: racePage.id,
        title: 'Race',
        body: doc('RACE LEFT'),
        updatedAt: raceLoaded.updatedAt,
      }),
      callSaveFn(base, ada.cookie, fn, {
        pageId: racePage.id,
        title: 'Race',
        body: doc('RACE RIGHT'),
        updatedAt: raceLoaded.updatedAt,
      }),
    ])
    const raceStored = JSON.stringify(
      (await app.getPageView(ada.userId, racePage.id)).body,
    )
    const raceWins = [raceLeft, raceRight].filter((status) => status === 200).length
    const raceConflicts = [raceLeft, raceRight].filter(
      (status) => status === 409,
    ).length
    const raceKept =
      (raceLeft === 200 &&
        raceStored.includes('RACE LEFT') &&
        !raceStored.includes('RACE RIGHT')) ||
      (raceRight === 200 &&
        raceStored.includes('RACE RIGHT') &&
        !raceStored.includes('RACE LEFT'))
    line('50_fc1_head_race_200', raceWins)
    line('50_fc1_head_race_409', raceConflicts)
    line('50_fc1_head_race_stored', raceKept)

    const apiRacePage = await app.createPage(ada.userId, {
      spaceId: serverPage.spaceId,
      title: 'Api race',
    })
    const apiRaceBase = await callSaveApi(base, ada.cookie, {
      pageId: apiRacePage.id,
      title: 'Api race',
      body: doc('base'),
      updatedAt: apiRacePage.updatedAt,
    })
    if (apiRaceBase.status !== 204 || !apiRaceBase.updatedAt)
      throw new Error('api race base save failed')
    const [apiRaceLeft, apiRaceRight] = await Promise.all([
      callSaveApi(base, ada.cookie, {
        pageId: apiRacePage.id,
        title: 'Api race',
        body: doc('RACE LEFT'),
        updatedAt: apiRaceBase.updatedAt,
      }),
      callSaveApi(base, ada.cookie, {
        pageId: apiRacePage.id,
        title: 'Api race',
        body: doc('RACE RIGHT'),
        updatedAt: apiRaceBase.updatedAt,
      }),
    ])
    const apiRaceStored = JSON.stringify(
      (await app.getPageView(ada.userId, apiRacePage.id)).body,
    )
    const apiRaceWins = [apiRaceLeft, apiRaceRight].filter(
      (item) => item.status === 204,
    ).length
    const apiRaceConflicts = [apiRaceLeft, apiRaceRight].filter(
      (item) => item.status === 409,
    ).length
    const apiRaceKept =
      (apiRaceLeft.status === 204 &&
        apiRaceStored.includes('RACE LEFT') &&
        !apiRaceStored.includes('RACE RIGHT')) ||
      (apiRaceRight.status === 204 &&
        apiRaceStored.includes('RACE RIGHT') &&
        !apiRaceStored.includes('RACE LEFT'))
    line('50_fc1_head_api_race_204', apiRaceWins)
    line('50_fc1_head_api_race_409', apiRaceConflicts)
    line('50_fc1_head_api_race_stored', apiRaceKept)
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
      winner(apiAfter.body) === 'alice' &&
      raceWins === 1 &&
      raceConflicts === 1 &&
      raceKept &&
      apiRaceWins === 1 &&
      apiRaceConflicts === 1 &&
      apiRaceKept
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
    process.env.ATLAS_ARTIFACTS_DIR || '/opt/cursor/artifacts',
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

type StampPair = {
  withStamp: number
  withStored: boolean
  withoutStamp: number
  withoutStored: boolean
}

async function mcpStampPair(root: string): Promise<StampPair> {
  const href = (rel: string) => pathToFileURL(join(root, rel)).href
  const app = await loadApp(root)
  try {
    const tokens = (await import(href('src/lib/api-tokens.ts'))) as {
      createApiToken: (
        userId: string,
        input: { name: string; scope: string; expiry: string },
      ) => Promise<{ token: string }>
    }
    const mcp = (await import(href('src/lib/mcp.ts'))) as {
      handleMcp: (request: Request) => Promise<Response>
    }
    const owner = await app.createUser('Ada')
    const issued = await tokens.createApiToken(owner.user.id, {
      name: 'agent',
      scope: 'read_write',
      expiry: '90d',
    })
    const update = async (pageId: string, args: Record<string, unknown>) => {
      const response = await mcp.handleMcp(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${issued.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'update_page', arguments: { page_id: pageId, ...args } },
          }),
        }),
      )
      await response.text()
      return response.status
    }
    const stamped = await app.createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Stamped',
    })
    const stamp = (await app.getPageView(owner.user.id, stamped.id)).updatedAt
    const withStamp = await update(stamped.id, {
      body: 'stamped write',
      updated_at: stamp,
    })
    const withView = await app.getPageView(owner.user.id, stamped.id)
    const bare = await app.createPage(owner.user.id, {
      spaceId: owner.space.id,
      title: 'Bare',
    })
    const withoutStamp = await update(bare.id, { body: 'unstamped write' })
    const withoutView = await app.getPageView(owner.user.id, bare.id)
    return {
      withStamp,
      withStored: JSON.stringify(withView.body).includes('stamped write'),
      withoutStamp,
      withoutStored: JSON.stringify(withoutView.body).includes('unstamped write'),
    }
  } finally {
    await app.closeDb().catch(() => undefined)
    if (root !== repoRoot) rmSync(root, { recursive: true, force: true })
  }
}

function strictPair(pair: StampPair) {
  return (
    pair.withStamp === 200 &&
    pair.withStored &&
    pair.withoutStamp === 409 &&
    !pair.withoutStored
  )
}

async function regMcp() {
  databaseUrl()
  ensureAuthEnv()
  const head = await mcpStampPair(repoRoot)
  line('50_reg_mcp_head_with_stamp', head.withStamp)
  line('50_reg_mcp_head_with_stamp_stored', head.withStored)
  line('50_reg_mcp_head_without_stamp', head.withoutStamp)
  line('50_reg_mcp_head_without_stamp_stored', head.withoutStored)
  const pinRoot = await materializePin()
  const pin = await mcpStampPair(pinRoot)
  line('50_reg_mcp_pin_with_stamp', pin.withStamp)
  line('50_reg_mcp_pin_with_stamp_stored', pin.withStored)
  line('50_reg_mcp_pin_without_stamp', pin.withoutStamp)
  line('50_reg_mcp_pin_without_stamp_stored', pin.withoutStored)
  const same =
    head.withStamp === pin.withStamp &&
    head.withStored === pin.withStored &&
    head.withoutStamp === pin.withoutStamp &&
    head.withoutStored === pin.withoutStored
  line('50_reg_mcp_same', same)
  return strictPair(head) && strictPair(pin) && same
}

async function staleLibrary(app: App) {
  const owner = await app.createUser('Ada')
  const made = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Shared',
  })
  await app.savePage(owner.user.id, {
    pageId: made.id,
    title: 'Shared',
    body: doc('base'),
  })
  const loaded = await app.getPageView(owner.user.id, made.id)
  await app.savePage(owner.user.id, {
    pageId: made.id,
    title: 'Shared',
    body: doc('newer text survives'),
    updatedAt: loaded.updatedAt,
  })
  const stale = await statusOf(() =>
    app.savePage(owner.user.id, {
      pageId: made.id,
      title: 'Shared',
      body: doc('stale text lost'),
      updatedAt: loaded.updatedAt,
    }),
  )
  const stored = JSON.stringify((await app.getPageView(owner.user.id, made.id)).body)
  return {
    stale,
    newer: stored.includes('newer text survives') && !stored.includes('stale text lost'),
  }
}

async function fc4Planted() {
  databaseUrl()
  ensureAuthEnv()
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
  line(
    '50_fc4_planted_server_fn_unversioned',
    serverFn.length > 0 && !serverFn.includes('updatedAt'),
  )
  line(
    '50_fc4_planted_api_unversioned',
    api.length > 0 && !api.includes('updatedAt'),
  )
  const serverRoot = await materializePin()
  const server = await withApp(serverRoot, (app) => staleLibrary(app))
  line('50_fc4_planted_server_status', server.stale)
  line('50_fc4_planted_server_newer', server.newer)
  const apiRoot = await materializePin()
  const apiSave = await withApp(apiRoot, (app) => staleLibrary(app))
  line('50_fc4_planted_api_status', apiSave.stale)
  line('50_fc4_planted_api_newer', apiSave.newer)
  return (
    serverFn.length > 0 &&
    !serverFn.includes('updatedAt') &&
    api.length > 0 &&
    !api.includes('updatedAt') &&
    server.stale === 200 &&
    !server.newer &&
    apiSave.stale === 200 &&
    !apiSave.newer
  )
}

async function fc4Head() {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const app = await headApp()
  try {
    const fn = await serverFnId()
    const ada = await signUp(base, 'Ada')
    const team = await app.createTeam(ada.userId, 'Paths')
    const serverPage = await app.createPage(ada.userId, {
      spaceId: team.spaceId,
      title: 'Server',
    })
    const serverBase = await callSaveFn(base, ada.cookie, fn, {
      pageId: serverPage.id,
      title: 'Server',
      body: doc('base'),
      updatedAt: serverPage.updatedAt,
    })
    if (serverBase !== 200) throw new Error('server base save failed')
    const serverLoaded = await app.getPageView(ada.userId, serverPage.id)
    const serverNewer = await callSaveFn(base, ada.cookie, fn, {
      pageId: serverPage.id,
      title: 'Server',
      body: doc('newer text survives'),
      updatedAt: serverLoaded.updatedAt,
    })
    const serverStale = await callSaveFn(base, ada.cookie, fn, {
      pageId: serverPage.id,
      title: 'Server',
      body: doc('stale text lost'),
      updatedAt: serverLoaded.updatedAt,
    })
    const serverStored = JSON.stringify(
      (await app.getPageView(ada.userId, serverPage.id)).body,
    )
    const serverKept =
      serverStored.includes('newer text survives') &&
      !serverStored.includes('stale text lost')
    line('50_fc4_head_server_fresh', serverNewer)
    line('50_fc4_head_server_status', serverStale)
    line('50_fc4_head_server_newer', serverKept)

    const apiPage = await app.createPage(ada.userId, {
      spaceId: team.spaceId,
      title: 'Api',
    })
    const apiBase = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Api',
      body: doc('base'),
      updatedAt: apiPage.updatedAt,
    })
    if (apiBase.status !== 204 || !apiBase.updatedAt)
      throw new Error('api base save failed')
    const apiNewer = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Api',
      body: doc('newer text survives'),
      updatedAt: apiBase.updatedAt,
    })
    const apiStale = await callSaveApi(base, ada.cookie, {
      pageId: apiPage.id,
      title: 'Api',
      body: doc('stale text lost'),
      updatedAt: apiBase.updatedAt,
    })
    const apiStored = JSON.stringify(
      (await app.getPageView(ada.userId, apiPage.id)).body,
    )
    const apiKept =
      apiStored.includes('newer text survives') &&
      !apiStored.includes('stale text lost')
    line('50_fc4_head_api_fresh', apiNewer.status)
    line('50_fc4_head_api_status', apiStale.status)
    line('50_fc4_head_api_newer', apiKept)
    return (
      serverNewer === 200 &&
      serverStale === 409 &&
      serverKept &&
      apiNewer.status === 204 &&
      apiStale.status === 409 &&
      apiKept
    )
  } finally {
    await app.closeDb().catch(() => undefined)
  }
}

async function bareWrite(app: App, stamp: string | null) {
  const owner = await app.createUser('Ada')
  const made = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Bare',
  })
  await app.savePage(owner.user.id, {
    pageId: made.id,
    title: 'Bare',
    body: doc('base'),
  })
  const input: {
    pageId: string
    title: string
    body: Json
    updatedAt?: string
  } = {
    pageId: made.id,
    title: 'Bare',
    body: doc('unversioned write'),
  }
  if (stamp !== null) input.updatedAt = stamp
  const status = await statusOf(() => app.savePage(owner.user.id, input))
  const stored = JSON.stringify(
    (await app.getPageView(owner.user.id, made.id)).body,
  ).includes('unversioned write')
  return { status, stored }
}

async function fc5Planted() {
  databaseUrl()
  ensureAuthEnv()
  const labels = ['missing', 'empty', 'bad'] as const
  const stamps: Array<string | null> = [null, '', 'not-a-date']
  const server: Array<{ status: number; stored: boolean }> = []
  const api: Array<{ status: number; stored: boolean }> = []
  for (let i = 0; i < stamps.length; i += 1) {
    const serverRoot = await materializePin()
    server.push(await withApp(serverRoot, (app) => bareWrite(app, stamps[i])))
    const apiRoot = await materializePin()
    api.push(await withApp(apiRoot, (app) => bareWrite(app, stamps[i])))
    line(`50_fc5_planted_server_${labels[i]}`, server[i].status)
    line(`50_fc5_planted_server_${labels[i]}_stored`, server[i].stored)
    line(`50_fc5_planted_api_${labels[i]}`, api[i].status)
    line(`50_fc5_planted_api_${labels[i]}_stored`, api[i].stored)
  }
  return [...server, ...api].every((item) => item.status === 200 && item.stored)
}

async function refusedWrite(
  base: string,
  cookie: string,
  fn: string,
  pageId: string,
  route: 'server' | 'api',
  stamp: string | undefined,
) {
  const data: Record<string, unknown> = {
    pageId,
    title: 'Bare',
    body: doc('unversioned write'),
  }
  if (stamp !== undefined) data.updatedAt = stamp
  if (route === 'server') return callSaveFn(base, cookie, fn, data)
  return (await callSaveApi(base, cookie, data)).status
}

async function fc5Head() {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const app = await headApp()
  try {
    const fn = await serverFnId()
    const ada = await signUp(base, 'Ada')
    const team = await app.createTeam(ada.userId, 'Bare')
    const stamps: Array<{ label: string; value: string | undefined }> = [
      { label: 'missing', value: undefined },
      { label: 'empty', value: '' },
      { label: 'bad', value: 'not-a-date' },
    ]
    let ok = true
    for (const route of ['server', 'api'] as const) {
      const made = await app.createPage(ada.userId, {
        spaceId: team.spaceId,
        title: 'Bare',
      })
      const opened =
        route === 'server'
          ? await callSaveFn(base, ada.cookie, fn, {
              pageId: made.id,
              title: 'Bare',
              body: doc('base'),
              updatedAt: made.updatedAt,
            })
          : (await callSaveApi(base, ada.cookie, {
              pageId: made.id,
              title: 'Bare',
              body: doc('base'),
              updatedAt: made.updatedAt,
            })).status
      if (opened !== (route === 'server' ? 200 : 204))
        throw new Error(`${route} base save failed`)
      const before = await app.getPageView(ada.userId, made.id)
      for (const stamp of stamps) {
        const status = await refusedWrite(
          base,
          ada.cookie,
          fn,
          made.id,
          route,
          stamp.value,
        )
        const after = await app.getPageView(ada.userId, made.id)
        const stored = JSON.stringify(after.body).includes('unversioned write')
        const kept =
          !stored &&
          after.updatedAt === before.updatedAt &&
          status >= 400 &&
          status < 500
        line(`50_fc5_head_${route}_${stamp.label}`, status)
        line(`50_fc5_head_${route}_${stamp.label}_stored`, stored)
        if (!kept) ok = false
      }
    }
    return ok
  } finally {
    await app.closeDb().catch(() => undefined)
  }
}

async function threeSaves(app: App) {
  const owner = await app.createUser('Ada')
  const made = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Solo',
  })
  let stamp = made.updatedAt
  const statuses: number[] = []
  for (const text of ['one', 'two', 'three']) {
    const status = await statusOf(() =>
      app.savePage(owner.user.id, {
        pageId: made.id,
        title: 'Solo',
        body: doc(text),
        updatedAt: stamp,
      }),
    )
    statuses.push(status)
    if (status === 200) {
      stamp = (await app.getPageView(owner.user.id, made.id)).updatedAt
    }
  }
  return statuses
}

async function fc6Planted() {
  databaseUrl()
  ensureAuthEnv()
  const banner = pinText('src/components/PageEditor.tsx').includes(
    'Someone else changed this page since you opened it.',
  )
  line('50_fc6_planted_banner', banner)
  const plain = await materializePin()
  const pinOk = await withApp(plain, async (app) => {
    const statuses = await threeSaves(app)
    line('50_fc6_planted_pin_statuses', statuses.join(','))
    return statuses.length === 3 && statuses.every((status) => status === 200)
  })
  line('50_fc6_planted_pin_ok', pinOk)
  if (!pinOk) throw new Error('pin already self-conflicts')
  const tight = await materializePin()
  writeFileSync(
    join(tight, 'src/lib/pages.ts'),
    rejectEverySave(readFileSync(join(tight, 'src/lib/pages.ts'), 'utf8')),
  )
  const rejected = await withApp(tight, async (app) => {
    const statuses = await threeSaves(app)
    return statuses[0] ?? 0
  })
  line('50_fc6_planted_fixture', 'reject-save')
  line('50_fc6_planted_status', rejected)
  return rejected === 409
}

async function fc6Head() {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const app = await headApp()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const statuses: number[] = []
  const marked = new Set<object>()
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes('_serverFn')) return
    let post = ''
    try {
      post = request.postData() ?? ''
    } catch {
      return
    }
    if (post.includes('fc6mark')) marked.add(request)
  })
  page.on('response', (response) => {
    if (!marked.has(response.request())) return
    statuses.push(response.status())
  })
  try {
    const ada = await signUp(base, 'Ada')
    const team = await app.createTeam(ada.userId, 'Solo')
    const made = await app.createPage(ada.userId, {
      spaceId: team.spaceId,
      title: 'Solo',
    })
    await signIn(page, base, ada.email, ada.password)
    await page.goto(`${base}/s/${team.spaceId}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.locator('#page-title').waitFor()
    await enterEdit(page)
    await page.locator('.doc-editor').click()
    for (const extra of ['fc6mark', ' two', ' three']) {
      const before = statuses.length
      await page.keyboard.type(extra)
      const deadline = Date.now() + 8000
      while (statuses.length === before) {
        if (Date.now() > deadline) throw new Error('autosave missing')
        await page.waitForTimeout(100)
      }
    }
    const banner = await page
      .getByText('Someone else changed this page since you opened it.')
      .count()
    const allOk = statuses.length >= 3 && statuses.every((status) => status === 200)
    line('50_fc6_head_count', statuses.length)
    line('50_fc6_head_statuses', statuses.join(','))
    line('50_fc6_head_all_200', allOk)
    line('50_fc6_head_banner', banner > 0)
    return allOk && banner === 0
  } finally {
    await browser.close()
    await app.closeDb().catch(() => undefined)
  }
}

const FC8_PIN = '47ecfa713b67b8143d92e34886e679419cfcc98f'

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

async function bootPinServer(root: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err = `${err}${chunk.toString()}`.slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(redact(err || 'pin build failed')))
    })
  })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = spawn('node', ['.output/server/index.mjs'], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      BETTER_AUTH_URL: base,
    },
    stdio: 'ignore',
  })
  child.unref()
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
  }
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/sign-in`)
      if (response.status === 200) {
        await response.text().catch(() => '')
        return { base, stop }
      }
      await response.text().catch(() => '')
    } catch {
      // the process is still binding
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  stop()
  throw new Error('pin server did not start')
}

async function drawStroke(page: Page) {
  const canvas = page.locator('.diagram-screen .excalidraw canvas').first()
  await canvas.waitFor({ timeout: 30000 })
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas missing')
  const startX = box.x + box.width * 0.45
  const startY = box.y + box.height * 0.45
  await page.mouse.click(startX, startY)
  await page.keyboard.press('r')
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 160, startY + 100, { steps: 10 })
  await page.mouse.up()
}

async function diagramRetype(base: string) {
  const app = await headApp()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const saves: Array<{ marker: string; status: number }> = []
  const markers = new Map<object, string>()
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes('_serverFn'))
      return
    let post = ''
    try {
      post = request.postData() ?? ''
    } catch {
      return
    }
    const marker = post.includes('fc8next')
      ? 'fc8next'
      : post.includes('fc8mark')
        ? 'fc8mark'
        : ''
    if (marker) markers.set(request, marker)
  })
  page.on('response', (response) => {
    const marker = markers.get(response.request())
    if (!marker) return
    saves.push({ marker, status: response.status() })
  })
  let drawing = 0
  try {
    const ada = await signUp(base, 'Ada')
    const team = await app.createTeam(ada.userId, 'Diagram')
    const made = await app.createPage(ada.userId, {
      spaceId: team.spaceId,
      title: 'Diagram',
    })
    await signIn(page, base, ada.email, ada.password)
    await page.goto(`${base}/s/${team.spaceId}/p/${made.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.locator('#page-title').waitFor()
    await enterEdit(page)
    await page.locator('.doc-editor').click()
    const beforeType = saves.length
    await page.keyboard.type('fc8mark')
    const typeDeadline = Date.now() + 12000
    while (saves.length === beforeType) {
      if (Date.now() > typeDeadline) throw new Error('text save missing')
      await page.waitForTimeout(100)
    }
    const typed = saves[beforeType]
    if (!typed || typed.status !== 200) throw new Error('text save failed')
    const beforeInsert = saves.length
    await page.getByRole('button', { name: 'Drawing' }).click()
    await page.getByText('Empty drawing').waitFor({ timeout: 15000 })
    const insertDeadline = Date.now() + 12000
    while (saves.length === beforeInsert) {
      if (Date.now() > insertDeadline)
        throw new Error('diagram insert save missing')
      await page.waitForTimeout(100)
    }
    if (saves[beforeInsert]?.status !== 200)
      throw new Error('diagram insert save failed')
    await page.locator('.diagram-block .diagram-edit').click()
    await page
      .locator('.diagram-screen .excalidraw')
      .waitFor({ timeout: 30000 })
    await drawStroke(page)
    const doneResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/drawings'),
      { timeout: 30000 },
    )
    await page
      .locator('.diagram-bar')
      .getByRole('button', { name: 'Done' })
      .click()
    drawing = (await doneResponse).status()
    await page
      .locator('.diagram-screen')
      .waitFor({ state: 'hidden', timeout: 15000 })
    await page.getByText('fc8mark', { exact: true }).click()
    await page.keyboard.press('End')
    const beforeNext = saves.length
    await page.keyboard.type(' fc8next')
    const nextDeadline = Date.now() + 12000
    while (!saves.slice(beforeNext).some((save) => save.marker === 'fc8next')) {
      if (Date.now() > nextDeadline) throw new Error('follow-up save missing')
      await page.waitForTimeout(100)
    }
    const again = saves
      .slice(beforeNext)
      .find((save) => save.marker === 'fc8next')
    const conflict = page.getByText(
      'Someone else changed this page since you opened it.',
    )
    await conflict.waitFor({ timeout: 4000 }).catch(() => undefined)
    const banner = await conflict.count()
    const stored = await app.getPageView(ada.userId, made.id)
    const text = JSON.stringify(stored.body)
    return {
      type: typed.status,
      drawing,
      again: again?.status ?? 0,
      banner: banner > 0,
      persisted: text.includes('fc8mark') && text.includes('fc8next'),
    }
  } finally {
    await browser.close()
    await app.closeDb().catch(() => undefined)
  }
}

async function fc8Planted() {
  databaseUrl()
  ensureAuthEnv()
  const root = await materializePin(FC8_PIN)
  const server = await bootPinServer(root)
  try {
    const result = await diagramRetype(server.base)
    line('50_fc8_planted_type', result.type)
    line('50_fc8_planted_drawing', result.drawing)
    line('50_fc8_planted_again', result.again)
    line('50_fc8_planted_banner', result.banner)
    line('50_fc8_planted_persisted', result.persisted)
    return result.again !== 200 || result.banner || !result.persisted
  } finally {
    server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function fc8Head() {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const result = await diagramRetype(base)
  line('50_fc8_head_type', result.type)
  line('50_fc8_head_drawing', result.drawing)
  line('50_fc8_head_again', result.again)
  line('50_fc8_head_banner', result.banner)
  line('50_fc8_head_persisted', result.persisted)
  return (
    result.type === 200 &&
    result.drawing === 200 &&
    result.again === 200 &&
    !result.banner &&
    result.persisted
  )
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
  } else if (mode === 'fc4-planted') {
    const bug = await fc4Planted()
    process.exit(bug ? 1 : 0)
  } else if (mode === 'fc4') {
    const ok = await fc4Head()
    process.exit(ok ? 0 : 1)
  } else if (mode === 'fc5-planted') {
    const bug = await fc5Planted()
    process.exit(bug ? 1 : 0)
  } else if (mode === 'fc5') {
    const ok = await fc5Head()
    process.exit(ok ? 0 : 1)
  } else if (mode === 'fc6-planted') {
    const bug = await fc6Planted()
    process.exit(bug ? 1 : 0)
  } else if (mode === 'fc6') {
    const ok = await fc6Head()
    process.exit(ok ? 0 : 1)
  } else if (mode === 'reg-mcp') {
    const ok = await regMcp()
    process.exit(ok ? 0 : 1)
  } else if (mode === 'fc8-planted') {
    const bug = await fc8Planted()
    process.exit(bug ? 1 : 0)
  } else if (mode === 'fc8') {
    const ok = await fc8Head()
    process.exit(ok ? 0 : 1)
  } else {
    throw new Error('usage')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'failed'
  line('50_error', redact(message))
  process.exit(1)
}
