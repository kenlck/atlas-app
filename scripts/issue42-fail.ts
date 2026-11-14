import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertLocalDatabaseUrl } from './verify-local.ts'

// Pinned main. Never origin/main: that ref moves.
const MAIN_PIN = 'c22273c90c9027a3113d5eb361df99a6328034dc'
const SAVE_LIMIT_MS = 4000
const SAVE_COUNT = 10

const ADOPT_IN_TX =
  'const adopted = await adoptDiagrams(tx, userId, pageId, body)'
const ACCESS_IN_ADOPT = `await assertAccess(userId, {
          pageId: row ? row.pageId : MISSING_DRAWING_PAGE,
        })`

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

type SavePage = (
  userId: string,
  input: { pageId: string; title: string; body: Json },
) => Promise<{ body: Json }>

type SqlClient = <T>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>

type App = {
  savePage: SavePage
  createPage: (
    userId: string,
    input: { spaceId: string; title: string },
  ) => Promise<{ id: string }>
  createDiagram: (userId: string, pageId: string) => Promise<{ id: string }>
  createUser: (
    name: string,
  ) => Promise<{ user: { id: string }; space: { id: string } }>
  HttpError: new (
    status: number,
    message: string,
  ) => { status: number; message: string }
  getSql: () => SqlClient
  closeDb: () => Promise<void>
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
let scratch: string | null = null

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'failed'
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
}

function finish(code: number): never {
  if (scratch) {
    const link = path.join(scratch, 'node_modules')
    rmSync(link, { force: true })
    rmSync(scratch, { recursive: true, force: true })
    scratch = null
  }
  process.exit(code)
}

function requireLocalDatabase() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL or TEST_DATABASE_URL is required')
    finish(2)
  }
  try {
    assertLocalDatabaseUrl(url)
  } catch {
    console.error('refusing non-local database')
    finish(2)
  }
  process.env.DATABASE_URL = url
}

function ensureAuthEnv() {
  if (
    !process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_SECRET.length < 32
  ) {
    process.env.BETTER_AUTH_SECRET = 'issue42-fail-secret-not-a-credential'
  }
  if (!process.env.BETTER_AUTH_URL) {
    process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3000'
  }
}

function pinMatches() {
  const pages = execFileSync('git', ['show', `${MAIN_PIN}:src/lib/pages.ts`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const access = execFileSync(
    'git',
    ['show', `${MAIN_PIN}:src/lib/access.ts`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )
  const signatureStart = access.indexOf('export async function assertAccess(')
  const signatureEnd = access.indexOf('Promise<AccessResult>')
  const signature =
    signatureStart >= 0 && signatureEnd > signatureStart
      ? access.slice(signatureStart, signatureEnd)
      : ''
  return (
    pages.includes(ADOPT_IN_TX) &&
    pages.includes(ACCESS_IN_ADOPT) &&
    access.includes('const db = getDb()') &&
    signature.length > 0 &&
    !signature.includes('db:')
  )
}

function materializePin() {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-42-'))
  const git = spawn('git', ['archive', '--format=tar', MAIN_PIN], {
    cwd: repoRoot,
  })
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
        symlinkSync(
          path.join(repoRoot, 'node_modules'),
          path.join(dir, 'node_modules'),
        )
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
  const href = (rel: string) => pathToFileURL(path.join(root, rel)).href
  const pages = (await import(href('src/lib/pages.ts'))) as Pick<
    App,
    'savePage' | 'createPage' | 'createDiagram'
  >
  const helpers = (await import(href('tests/helpers.ts'))) as Pick<
    App,
    'createUser'
  >
  const http = (await import(href('src/lib/http.ts'))) as Pick<App, 'HttpError'>
  const db = (await import(href('src/lib/db.ts'))) as Pick<
    App,
    'getSql' | 'closeDb'
  >
  return {
    savePage: pages.savePage,
    createPage: pages.createPage,
    createDiagram: pages.createDiagram,
    createUser: helpers.createUser,
    HttpError: http.HttpError,
    getSql: db.getSql,
    closeDb: db.closeDb,
  }
}

function diagramBody(drawingId: string): Json {
  return {
    type: 'doc',
    content: [{ type: 'diagram', attrs: { drawingId } }],
  }
}

function rawDrawingId(body: Json) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const content = body.content
  if (!Array.isArray(content)) return null
  const node = content[0]
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const attrs = node.attrs
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null
  return typeof attrs.drawingId === 'string' ? attrs.drawingId : null
}

function classifyDrawing(body: Json, sourceId: string) {
  const id = rawDrawingId(body)
  if (id === null) return 'missing'
  if (id === '') return 'empty'
  if (id === sourceId) return 'source'
  return 'copied'
}

async function drawingIds(app: App, pageId: string) {
  const rows = await app.getSql()<{ id: string }[]>`
    select id from drawing where page_id = ${pageId}
  `
  return rows.map((row) => row.id)
}

async function runFc1(app: App, planted: boolean) {
  const label = planted ? '42_fc1_planted' : '42_fc1_head'
  const owner = await app.createUser(planted ? 'Planted Adopt' : 'Head Adopt')
  const source = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Source',
  })
  const diagram = await app.createDiagram(owner.user.id, source.id)
  const dests: Array<{ id: string }> = []
  for (let i = 0; i < SAVE_COUNT; i += 1) {
    dests.push(
      await app.createPage(owner.user.id, {
        spaceId: owner.space.id,
        title: `Dest ${i}`,
      }),
    )
  }
  const body = diagramBody(diagram.id)
  // Fill the pool so the ten transactions reserve every connection before
  // any of them asks for another one.
  await Promise.all(
    Array.from({ length: SAVE_COUNT }, () => app.getSql()`select 1`),
  )
  const started = performance.now()
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    const elapsed = Math.round(performance.now() - started)
    console.log(`${label}_elapsed_ms=${elapsed}`)
    console.log(`${label}_timeout=true`)
    console.log(`${label}_finished=0`)
    console.log(`${label}_adopted=0`)
    finish(1)
  }, SAVE_LIMIT_MS)
  try {
    const views = await Promise.all(
      dests.map((dest) =>
        app.savePage(owner.user.id, {
          pageId: dest.id,
          title: 'Dest',
          body,
        }),
      ),
    )
    settled = true
    clearTimeout(timer)
    const elapsed = Math.round(performance.now() - started)
    let adopted = 0
    for (let i = 0; i < dests.length; i += 1) {
      const dest = dests[i]
      const view = views[i]
      if (!dest || !view) continue
      const ids = (await drawingIds(app, dest.id)).filter(
        (id) => id !== diagram.id,
      )
      const kept = rawDrawingId(view.body)
      if (ids.length === 1 && kept && kept !== diagram.id && ids[0] === kept)
        adopted += 1
    }
    console.log(`${label}_elapsed_ms=${elapsed}`)
    console.log(`${label}_timeout=false`)
    console.log(`${label}_finished=${views.length}`)
    console.log(`${label}_adopted=${adopted}`)
    const ok =
      elapsed < SAVE_LIMIT_MS &&
      views.length === SAVE_COUNT &&
      adopted === SAVE_COUNT
    await app.closeDb()
    finish(ok ? 0 : planted ? 2 : 1)
  } catch (error) {
    clearTimeout(timer)
    if (!settled) {
      settled = true
      const elapsed = Math.round(performance.now() - started)
      console.log(`${label}_elapsed_ms=${elapsed}`)
      console.log(`${label}_timeout=false`)
      console.log(`${label}_finished=0`)
      console.log(`${label}_adopted=0`)
      console.error(`${label}_error=${safeError(error)}`)
    }
    finish(2)
  }
}

async function runFc2(app: App, label: '42_fc2_main' | '42_fc2_head') {
  const owner = await app.createUser('Private Source')
  const outsider = await app.createUser('Outside Reader')
  const source = await app.createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Private',
  })
  const diagram = await app.createDiagram(owner.user.id, source.id)
  const dest = await app.createPage(outsider.user.id, {
    spaceId: outsider.space.id,
    title: 'Mine',
  })
  // savePage returns the page when the write commits. The save route maps
  // that to 204, and maps a thrown HttpError onto its status and message.
  let status = 204
  let errorName = 'none'
  let body: Json | null = null
  try {
    const view = await app.savePage(outsider.user.id, {
      pageId: dest.id,
      title: 'Mine',
      body: diagramBody(diagram.id),
    })
    body = view.body
  } catch (error) {
    if (!(error instanceof app.HttpError)) {
      console.log(`${label}_status=0`)
      console.log(`${label}_error=unexpected`)
      console.log(`${label}_copied=false`)
      console.log(`${label}_drawing_id=missing`)
      console.error(`${label}_detail=${safeError(error)}`)
      await app.closeDb().catch(() => undefined)
      finish(1)
    }
    status = error.status
    errorName = error.message.replace(/[\r\n]+/g, ' ')
  }
  const copied = (await drawingIds(app, dest.id)).some(
    (id) => id !== diagram.id,
  )
  const drawingId = body ? classifyDrawing(body, diagram.id) : 'missing'
  console.log(`${label}_status=${status}`)
  console.log(`${label}_error=${errorName}`)
  console.log(`${label}_copied=${copied}`)
  console.log(`${label}_drawing_id=${drawingId}`)
  await app.closeDb()
  finish(0)
}

async function main() {
  const mode = process.argv[2] ?? ''
  requireLocalDatabase()
  ensureAuthEnv()
  const pinned = mode === 'fc1-planted' || mode === 'fc2-main'
  if (pinned) {
    const match = pinMatches()
    console.log(`42_pin=${MAIN_PIN}`)
    console.log(`42_pin_match=${match}`)
    if (mode === 'fc1-planted') {
      console.log(`42_fc1_pin=${MAIN_PIN}`)
      console.log(`42_fc1_pin_match=${match}`)
    }
    if (!match) finish(2)
    scratch = await materializePin()
  }
  const app = await loadApp(pinned && scratch ? scratch : repoRoot)
  if (mode === 'fc1-planted') await runFc1(app, true)
  else if (mode === 'fc1') await runFc1(app, false)
  else if (mode === 'fc2-main') await runFc2(app, '42_fc2_main')
  else if (mode === 'fc2-head') await runFc2(app, '42_fc2_head')
  else {
    console.error('usage: issue42-fail.ts fc1-planted|fc1|fc2-main|fc2-head')
    finish(2)
  }
}

main().catch((error) => {
  console.error(`42_fail=${safeError(error)}`)
  finish(2)
})
