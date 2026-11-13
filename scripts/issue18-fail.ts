import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { chromium } from 'playwright'
import type { Page, Request } from 'playwright'
import { assertAccess } from '../src/lib/access'
import { closeDb, getDb, getSql } from '../src/lib/db'
import { flushEditor, registerEditorFlush } from '../src/lib/editor-flush'
import {
  oldCreatePage,
  oldFlushEditor,
  oldFlushSave,
  registerOldEditorFlush,
} from './fixtures/issue18-old-flush.ts'
import { HttpError } from '../src/lib/http'
import { newId } from '../src/lib/ids'
import { createPage, savePage } from '../src/lib/pages'
import { page as pageTable, teamInvite } from '../src/lib/schema'
import {
  ALREADY_INVITED,
  acceptInvite,
  createInvite,
  createTeam,
  removeMember,
} from '../src/lib/teams'
import { createUser } from '../tests/helpers'
import {
  assertLocalBaseUrl,
  assertLocalDatabaseUrl,
  submitAuthForm,
} from './verify-local.ts'

process.env.BETTER_AUTH_URL ||= process.env.BASE_URL || 'http://127.0.0.1:3000'

function safeMessage(error: unknown) {
  let message = error instanceof Error ? error.message : 'error'
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
  for (const key of [
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'BETTER_AUTH_SECRET',
    'ADMIN_API_SECRET',
    'VERIFY_PASSWORD',
  ]) {
    const value = process.env[key]
    if (value && value.length >= 8)
      message = message.split(value).join('[redacted]')
  }
  return message
    .split('correct-horse-battery')
    .join('[redacted]')
    .split('\n')[0]
}

function postgresCode(error: unknown) {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^\d{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return ''
}

function requireDatabase() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required')
  assertLocalDatabaseUrl(url)
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = url
  return url
}

function tokenRgb(name: string) {
  const css = readFileSync(
    new URL('../src/styles.css', import.meta.url),
    'utf8',
  )
  const start = css.indexOf(':root {')
  const end = css.indexOf('\n}', start)
  const match = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(
    css.slice(start, end),
  )
  if (!match?.[1]) throw new Error(`missing --${name}`)
  const hex = match[1]
  return `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`
}

function normalizeColor(value: string) {
  return value.replace(/\s+/g, '')
}

function plantedExit(negative: boolean) {
  return negative ? 1 : 0
}

async function browser() {
  return chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}

async function clickNewPage(page: Page, beforePage?: () => void) {
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('button')].filter(
      (button) => button.textContent.trim() === '+ New page',
    )
    const button = buttons.at(-1)
    return Boolean(
      button &&
      Object.getOwnPropertyNames(button).some((key) =>
        key.startsWith('__reactProps$'),
      ),
    )
  })
  await page
    .getByRole('button', { name: '+ New page', exact: true })
    .last()
    .click()
  const choice = page.getByRole('button', { name: 'Page', exact: true })
  await choice.waitFor()
  beforePage?.()
  await choice.click()
}

async function waitForApp(page: Page) {
  await page.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
}

async function signIn(page: Page, email: string, password: string) {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  await page.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').waitFor()
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

function fc1Negative(sqlstate: string, http409: number) {
  return sqlstate === '23505' && http409 === 0
}

async function fc1UnconstrainedRace() {
  const sql = getSql()
  await sql`drop schema if exists planted_fc1 cascade`
  await sql`create schema planted_fc1`
  await sql`create table planted_fc1.invite (
    id text primary key,
    team_id text not null,
    invitee text not null,
    status text not null
  )`
  const once = () =>
    sql`insert into planted_fc1.invite (id, team_id, invitee, status)
      values (${newId()}, 'team', 'person', 'pending')`
  const results = await Promise.allSettled([once(), once()])
  const rejected = results.filter((item) => item.status === 'rejected')
  const sqlstate =
    rejected.map((item) => postgresCode(item.reason)).find(Boolean) ?? ''
  const http409 = rejected.filter(
    (item) => item.reason instanceof HttpError && item.reason.status === 409,
  ).length
  await sql`drop schema if exists planted_fc1 cascade`
  return { sqlstate, http409 }
}

async function fc1Planted() {
  requireDatabase()
  const owner = await createUser('Owner')
  const invited = await createUser('Invited')
  const created = await createTeam(owner.user.id, 'Planted invite')
  const db = getDb()
  const once = async () => {
    const id = newId()
    await db.insert(teamInvite).values({
      id,
      teamId: created.id,
      inviteeUserId: invited.user.id,
      invitedBy: owner.user.id,
      status: 'pending',
      createdAt: new Date(),
    })
    return id
  }
  const results = await Promise.allSettled([once(), once()])
  const ok = results.filter((item) => item.status === 'fulfilled').length
  const rejected = results.filter((item) => item.status === 'rejected')
  const codes = rejected.map((item) => postgresCode(item.reason))
  const http409 = rejected.filter(
    (item) => item.reason instanceof HttpError && item.reason.status === 409,
  ).length
  const rows = await db
    .select({ id: teamInvite.id })
    .from(teamInvite)
    .where(eq(teamInvite.teamId, created.id))
  const sqlstate = codes.find(Boolean) ?? ''
  const absent = await fc1UnconstrainedRace()
  console.log(`fc1_planted_ok=${ok}`)
  console.log(`fc1_planted_rejected=${rejected.length}`)
  console.log(`fc1_planted_sqlstate=${sqlstate}`)
  console.log(`fc1_planted_http_409=${http409}`)
  console.log(`fc1_planted_rows=${rows.length}`)
  console.log(`fc1_absent_sqlstate=${absent.sqlstate}`)
  console.log(`fc1_absent_http_409=${absent.http409}`)
  console.log(
    `fc1_absent_exit=${plantedExit(fc1Negative(absent.sqlstate, absent.http409))}`,
  )
  return plantedExit(fc1Negative(sqlstate, http409))
}

async function fc1Head() {
  requireDatabase()
  const owner = await createUser('Owner')
  const invited = await createUser('Invited')
  const created = await createTeam(owner.user.id, 'Head invite')
  const results = await Promise.allSettled([
    createInvite(owner.user.id, created.id, invited.user.id),
    createInvite(owner.user.id, created.id, invited.user.id),
  ])
  const ok = results.filter((item) => item.status === 'fulfilled')
  const denied = results.filter((item) => item.status === 'rejected')
  const reason = denied[0]?.reason
  const status = reason instanceof HttpError ? reason.status : 0
  const message = reason instanceof HttpError ? reason.message : ''
  const rows = await getDb()
    .select({ id: teamInvite.id })
    .from(teamInvite)
    .where(eq(teamInvite.teamId, created.id))
  console.log(`fc1_head_ok=${ok.length}`)
  console.log(`fc1_head_conflict=${denied.length}`)
  console.log(`fc1_head_status=${status}`)
  console.log(`fc1_head_message=${message}`)
  console.log(`fc1_head_rows=${rows.length}`)
  const raced =
    ok.length === 1 &&
    denied.length === 1 &&
    status === 409 &&
    message === ALREADY_INVITED &&
    rows.length === 1
  const ui = await fc1Ui(owner, invited.user.email, created.spaceId)
  return raced && ui ? 0 : 1
}

async function fc1Ui(
  owner: Awaited<ReturnType<typeof createUser>>,
  email: string,
  spaceId: string,
) {
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const session = await browser()
  const page = await session.newPage()
  try {
    await signIn(page, owner.user.email, owner.password)
    await page.goto(`${base}/s/${spaceId}/settings`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForApp(page)
    await page.locator('#invite-email').fill(email)
    await page.getByRole('button', { name: 'Look up' }).click()
    await page.getByRole('button', { name: 'Send invite' }).click()
    const alert = page.getByRole('alert')
    await alert.waitFor()
    const text = (await alert.innerText()).trim()
    const card = await page.locator('.found').count()
    console.log(`fc1_ui_alert=${text}`)
    console.log(`fc1_ui_card_kept=${card > 0}`)
    return text.includes(ALREADY_INVITED) && card > 0
  } finally {
    await session.close()
  }
}

async function waitForMemberLock() {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const locks = await getSql()`
      select count(*)::int as n
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and state = 'active'
        and query like 'select "user_id" from "team_member"%'
    `
    if (Number(locks[0]?.n) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

async function waitForPageLock() {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const locks = await getSql()`
      select count(*)::int as n
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and state = 'active'
        and (
          query like 'select "id", "space_id"%'
          or query ilike 'update "page"%'
        )
    `
    if (Number(locks[0]?.n) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

async function inFlight(
  memberId: string,
  ownerId: string,
  teamId: string,
  pageId: string,
  write: () => Promise<unknown>,
) {
  const hold = await getSql().reserve()
  try {
    await hold`begin`
    await hold`select id from page where id = ${pageId} for update`
    const pending = write().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const waiting = await waitForPageLock()
    if (!waiting) {
      await hold`rollback`
      return { waiting, pending: await pending }
    }
    await removeMember(ownerId, teamId, memberId)
    await hold`commit`
    return { waiting, pending: await pending }
  } finally {
    await hold`rollback`.catch(() => undefined)
    hold.release()
  }
}

async function removeDuringMemberWait(
  memberId: string,
  teamId: string,
  write: () => Promise<unknown>,
) {
  const hold = await getSql().reserve()
  try {
    await hold`begin`
    await hold`select user_id from team_member where team_id = ${teamId} and user_id = ${memberId} for update`
    const pending = write().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const waiting = await waitForMemberLock()
    if (!waiting) {
      await hold`rollback`
      return { waiting, pending: await pending }
    }
    await hold`delete from team_member where team_id = ${teamId} and user_id = ${memberId}`
    await hold`commit`
    return { waiting, pending: await pending }
  } finally {
    await hold`rollback`.catch(() => undefined)
    hold.release()
  }
}

async function setupSaveRace() {
  requireDatabase()
  const owner = await createUser('Owner')
  const member = await createUser('Member')
  const created = await createTeam(owner.user.id, 'Save race')
  await acceptInvite(
    member.user.id,
    (await createInvite(owner.user.id, created.id, member.user.id)).id,
  )
  const made = await createPage(member.user.id, {
    spaceId: created.spaceId,
    title: 'Notes',
  })
  return { owner, member, created, made }
}

async function fc2Planted() {
  const { owner, member, created, made } = await setupSaveRace()
  const doc = { type: 'doc', content: [{ type: 'paragraph' }] }
  const result = await inFlight(
    member.user.id,
    owner.user.id,
    created.id,
    made.id,
    async () => {
      await assertAccess(member.user.id, { pageId: made.id })
      await getDb()
        .update(pageTable)
        .set({
          title: 'In flight',
          body: doc,
          updatedBy: member.user.id,
          updatedAt: new Date(),
        })
        .where(eq(pageTable.id, made.id))
    },
  )
  const stored = await getDb()
    .select({ title: pageTable.title })
    .from(pageTable)
    .where(eq(pageTable.id, made.id))
  const title = stored[0]?.title ?? ''
  const absent = await setupSaveRace()
  const absentDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
  const absentResult = await removeDuringMemberWait(
    absent.member.user.id,
    absent.created.id,
    () =>
      savePage(absent.member.user.id, {
        pageId: absent.made.id,
        title: 'In flight',
        body: absentDoc,
      }),
  )
  const absentStored = await getDb()
    .select({ title: pageTable.title })
    .from(pageTable)
    .where(eq(pageTable.id, absent.made.id))
  const absentTitle = absentStored[0]?.title ?? ''
  console.log(`fc2_planted_waiting=${result.waiting}`)
  console.log(`fc2_planted_stored=${title === 'In flight'}`)
  console.log(`fc2_planted_title=${title}`)
  console.log(`fc2_absent_title=${absentTitle}`)
  console.log(`fc2_absent_waiting=${absentResult.waiting}`)
  console.log(`fc2_absent_exit=${plantedExit(absentTitle === 'In flight')}`)
  return plantedExit(title === 'In flight')
}

async function fc2Head() {
  const { member, created, made } = await setupSaveRace()
  const doc = { type: 'doc', content: [{ type: 'paragraph' }] }
  const result = await removeDuringMemberWait(member.user.id, created.id, () =>
    savePage(member.user.id, {
      pageId: made.id,
      title: 'In flight',
      body: doc,
    }),
  )
  const status =
    !result.pending.ok && result.pending.error instanceof HttpError
      ? result.pending.error.status
      : 0
  const stored = await getDb()
    .select({ title: pageTable.title })
    .from(pageTable)
    .where(eq(pageTable.id, made.id))
  const title = stored[0]?.title ?? ''
  console.log(`fc2_head_waiting=${result.waiting}`)
  console.log(`fc2_head_stored=${title === 'In flight'}`)
  console.log(`fc2_head_status=${status}`)
  console.log(`fc2_head_title=${title}`)
  return result.waiting && title === 'Notes' && status === 404 ? 0 : 1
}

function fc3Negative(code: string, deleted: boolean) {
  return code === '23503' && !deleted
}

async function fc3DeleteSender(onDelete: 'restrict' | 'set null') {
  const sql = getSql()
  await sql`drop schema if exists planted_fc3 cascade`
  await sql`create schema planted_fc3`
  await sql`create table planted_fc3.person (id text primary key)`
  if (onDelete === 'set null') {
    await sql`create table planted_fc3.invite (
      id text primary key,
      invited_by text references planted_fc3.person(id) on delete set null
    )`
  } else {
    await sql`create table planted_fc3.invite (
      id text primary key,
      invited_by text not null references planted_fc3.person(id)
    )`
  }
  await sql`insert into planted_fc3.person (id) values ('sender')`
  await sql`insert into planted_fc3.invite (id, invited_by) values ('invite', 'sender')`
  let code = ''
  let deleted = false
  try {
    await sql`delete from planted_fc3.person where id = 'sender'`
    deleted = true
  } catch (error) {
    code = postgresCode(error)
  }
  const left = await sql`select count(*)::int as n from planted_fc3.invite`
  await sql`drop schema if exists planted_fc3 cascade`
  return { code, deleted, rows: Number(left[0]?.n ?? 0) }
}

async function fc3Planted() {
  requireDatabase()
  const blocked = await fc3DeleteSender('restrict')
  const cleared = await fc3DeleteSender('set null')
  console.log(`fc3_planted_sqlstate=${blocked.code}`)
  console.log(`fc3_planted_deleted=${blocked.deleted}`)
  console.log(`fc3_planted_invite_rows=${blocked.rows}`)
  console.log(`fc3_absent_sqlstate=${cleared.code}`)
  console.log(`fc3_absent_deleted=${cleared.deleted}`)
  console.log(
    `fc3_absent_exit=${plantedExit(fc3Negative(cleared.code, cleared.deleted))}`,
  )
  return plantedExit(fc3Negative(blocked.code, blocked.deleted))
}

async function fc3Head() {
  requireDatabase()
  const owner = await createUser('Owner')
  const invited = await createUser('Invited')
  const created = await createTeam(owner.user.id, 'Sender gone')
  const invite = await createInvite(owner.user.id, created.id, invited.user.id)
  let deleted = false
  let deleteCode = ''
  try {
    await getSql()`delete from "user" where id = ${owner.user.id}`
    deleted = true
  } catch (error) {
    deleteCode = postgresCode(error)
  }
  const rows = await getDb()
    .select()
    .from(teamInvite)
    .where(eq(teamInvite.id, invite.id))
  const ruleRows = await getSql()`
    select c.confdeltype as rule
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_attribute att on att.attrelid = rel.oid and att.attnum = any (c.conkey)
    where rel.relname = 'team_invite'
      and att.attname = 'invited_by'
      and c.contype = 'f'
  `
  const rule = String(ruleRows[0]?.rule ?? '')
  const onDelete =
    rule === 'n' ? 'set null' : rule === 'c' ? 'cascade' : rule || 'missing'
  console.log(`fc3_head_deleted=${deleted}`)
  console.log(`fc3_head_delete_sqlstate=${deleteCode}`)
  console.log(`fc3_head_invite_kept=${rows.length === 1}`)
  console.log(`fc3_head_invited_by=${rows[0]?.invitedBy ?? 'null'}`)
  console.log(`fc3_head_on_delete=${rule}`)
  console.log(`fc3_rule=${onDelete}`)
  return deleted &&
    rows.length === 1 &&
    rows[0]?.invitedBy == null &&
    rule === 'n'
    ? 0
    : 1
}

function isServerFn(request: Request) {
  return request.url().includes('/_serverFn/')
}

function requestText(request: Request) {
  return `${decodeURIComponent(request.url())} ${request.postData() ?? ''}`
}

function isSaveRequest(request: Request) {
  if (serverFnExport(request.url()).includes('savePageFn')) return true
  const text = requestText(request)
  return text.includes('"body"') && text.includes('"pageId"')
}

function isPageTreeUrl(href: string) {
  if (!href.includes('/_serverFn/')) return false
  if (serverFnExport(href).includes('fetchPageTree')) return true
  const text = decodeURIComponent(href)
  return (
    text.includes('"spaceId"') &&
    !text.includes('"pageId"') &&
    !text.includes('"screen"')
  )
}

function serverFnExport(url: string) {
  const id = new URL(url).pathname.split('/').pop() ?? ''
  try {
    const parsed = JSON.parse(
      Buffer.from(id, 'base64url').toString('utf8'),
    ) as { export?: unknown }
    return typeof parsed.export === 'string' ? parsed.export : ''
  } catch {
    return ''
  }
}

function fc4Negative(status: number, errors: number, row: string) {
  return status === 409 && errors === 0 && row === 'Invited'
}

async function fc4Send(page: Page, swallow: boolean) {
  await page.setContent(`<!doctype html>
    <button id="send">Send invite</button>
    <div id="row">Person</div>
    <script>
      document.getElementById('send').addEventListener('click', () => {
        fetch('http://127.0.0.1:9/invite').then((response) => {
          if (!response.ok && !${swallow}) {
            const alert = document.createElement('p')
            alert.className = 'err'
            alert.setAttribute('role', 'alert')
            alert.textContent = 'Already invited'
            document.body.appendChild(alert)
            return
          }
          document.getElementById('row').textContent = 'Invited'
        })
      })
    </script>`)
  const response = page.waitForResponse((item) =>
    item.url().includes('/invite'),
  )
  await page.locator('#send').click()
  const status = (await response).status()
  if (swallow) {
    await page.waitForFunction(
      () => document.getElementById('row')?.textContent === 'Invited',
    )
  } else {
    await page.locator('[role="alert"]').waitFor()
  }
  const errors = await page.locator('.err, [role="alert"]').count()
  const row = (await page.locator('#row').innerText()).trim()
  return { status, errors, row }
}

async function fc4Planted() {
  const session = await browser()
  const page = await session.newPage()
  try {
    await page.route('**/invite', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'text/plain',
        body: 'Already invited',
      }),
    )
    const hidden = await fc4Send(page, true)
    const shown = await fc4Send(page, false)
    console.log(`fc4_planted_status=${hidden.status}`)
    console.log(`fc4_planted_error_count=${hidden.errors}`)
    console.log(`fc4_planted_row=${hidden.row}`)
    console.log(`fc4_absent_status=${shown.status}`)
    console.log(`fc4_absent_error_count=${shown.errors}`)
    console.log(`fc4_absent_row=${shown.row}`)
    console.log(
      `fc4_absent_exit=${plantedExit(fc4Negative(shown.status, shown.errors, shown.row))}`,
    )
    return plantedExit(fc4Negative(hidden.status, hidden.errors, hidden.row))
  } finally {
    await session.close()
  }
}

async function fc4Head() {
  requireDatabase()
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const owner = await createUser('Owner')
  const member = await createUser('Member')
  const outsider = await createUser('Outsider')
  const created = await createTeam(owner.user.id, 'Settings errors')
  await acceptInvite(
    member.user.id,
    (await createInvite(owner.user.id, created.id, member.user.id)).id,
  )
  await createInvite(owner.user.id, created.id, outsider.user.id)
  const session = await browser()
  const page = await session.newPage()
  let fault: 'remove' | 'delete' | null = null
  const posts: number[] = []
  try {
    page.on('response', (response) => {
      if (
        response.request().method() === 'POST' &&
        isServerFn(response.request())
      ) {
        posts.push(response.status())
      }
    })
    await signIn(page, owner.user.email, owner.password)
    await page.goto(`${base}/s/${created.spaceId}/settings`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForApp(page)
    await page.locator('#invite-email').fill(outsider.user.email)
    await page.getByRole('button', { name: 'Look up' }).click()
    await page.getByRole('button', { name: 'Send invite' }).click()
    const alert = page.getByRole('alert')
    await alert.waitFor()
    const sendText = (await alert.innerText()).trim()
    const cardKept = (await page.locator('.found').count()) > 0
    const sendStatus = posts.at(-1) ?? 0
    console.log(`fc4_send_status=${sendStatus}`)
    console.log(`fc4_send_alert=${sendText}`)
    console.log(`fc4_send_card_kept=${cardKept}`)

    await page.route(
      (url) => url.pathname.includes('/_serverFn/'),
      async (route) => {
        const request = route.request()
        const body = request.postData() ?? ''
        const name = serverFnExport(request.url())
        const remove =
          fault === 'remove' &&
          request.method() === 'POST' &&
          (name.includes('removeMemberFn') || body.includes(member.user.id))
        const wipe =
          fault === 'delete' &&
          request.method() === 'POST' &&
          (name.includes('deleteTeamFn') ||
            (body.includes(created.id) &&
              !body.includes(member.user.id) &&
              !body.includes(outsider.user.id)))
        if (remove || wipe) {
          await route.fulfill({
            status: remove ? 500 : 409,
            contentType: 'text/plain',
            body: remove ? 'Internal Server Error' : 'Conflict',
          })
          return
        }
        await route.continue()
      },
    )
    fault = 'remove'
    const beforeRemove = posts.length
    await page.getByRole('button', { name: 'Remove' }).click()
    const removeDeadline = Date.now() + 5000
    while (posts.length === beforeRemove && Date.now() < removeDeadline) {
      await page.waitForTimeout(50)
    }
    const removeStatus = posts[beforeRemove] ?? 0
    await page.waitForFunction(() => {
      const node = document.querySelector('[role="alert"]')
      const text = node ? node.textContent.trim() : ''
      return text.length > 0 && text !== 'Already invited'
    })
    const memberKept = await page
      .getByText(member.user.name, { exact: true })
      .count()
    const removeAlert = (await alert.innerText()).trim()
    console.log(`fc4_remove_status=${removeStatus}`)
    console.log(`fc4_remove_row_kept=${memberKept > 0}`)
    console.log(`fc4_remove_alert=${removeAlert.length > 0}`)

    fault = 'delete'
    await page.getByRole('button', { name: 'Delete team' }).click()
    const beforeDelete = posts.length
    await page.locator('.delete-team').click()
    const deleteDeadline = Date.now() + 5000
    while (posts.length === beforeDelete && Date.now() < deleteDeadline) {
      await page.waitForTimeout(50)
    }
    const deleteStatus = posts[beforeDelete] ?? 0
    const removeText = removeAlert
    await page.waitForFunction((previous) => {
      const node = document.querySelector('[role="alert"]')
      const text = node ? node.textContent.trim() : ''
      return text.length > 0 && text !== previous
    }, removeText)
    const stayed = page.url().includes('/settings')
    const heading = (await page.locator('h1').innerText()).trim()
    const deleteAlert = (await alert.innerText()).trim()
    console.log(`fc4_delete_status=${deleteStatus}`)
    console.log(`fc4_delete_stayed=${stayed}`)
    console.log(`fc4_delete_heading=${heading}`)
    console.log(`fc4_delete_alert=${deleteAlert.length > 0}`)
    return sendStatus === 409 &&
      sendText.includes(ALREADY_INVITED) &&
      cardKept &&
      removeStatus === 500 &&
      memberKept > 0 &&
      removeAlert.length > 0 &&
      deleteStatus === 409 &&
      stayed &&
      heading === 'Settings errors' &&
      deleteAlert.length > 0
      ? 0
      : 1
  } finally {
    await session.close()
  }
}

function fc5Negative(
  created: boolean,
  surfaced: boolean,
  hangSettled: boolean,
  hangElapsed: number,
) {
  return created && !surfaced && !hangSettled && hangElapsed >= 5000
}

async function fc5FailedFlush(oldPath: boolean) {
  let created = false
  let surfaced = false
  const save = () => Promise.reject(new Error('save failed'))
  if (oldPath) {
    registerOldEditorFlush(() => oldFlushSave(save))
    try {
      await oldCreatePage(async () => {
        created = true
      })
    } catch {
      surfaced = true
    }
    return { created, surfaced }
  }
  const unregister = registerEditorFlush(save)
  try {
    await flushEditor(80)
    created = true
  } catch {
    surfaced = true
  } finally {
    unregister()
  }
  return { created, surfaced }
}

async function fc5HungFlush(oldPath: boolean) {
  let settled = false
  const started = Date.now()
  const hang = () => new Promise<void>(() => undefined)
  if (oldPath) {
    registerOldEditorFlush(hang)
    await Promise.race([
      oldFlushEditor().then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      ),
      new Promise((resolve) => setTimeout(resolve, 5100)),
    ])
    return { settled, elapsed: Date.now() - started }
  }
  const unregister = registerEditorFlush(hang)
  try {
    await flushEditor(80)
    settled = true
  } catch {
    settled = true
  } finally {
    unregister()
  }
  return { settled, elapsed: Date.now() - started }
}

async function fc5Planted() {
  const failed = await fc5FailedFlush(true)
  const hung = await fc5HungFlush(true)
  const absentFailed = await fc5FailedFlush(false)
  const absentHung = await fc5HungFlush(false)
  console.log(`fc5_planted_created=${failed.created}`)
  console.log(`fc5_planted_fail_surfaced=${failed.surfaced}`)
  console.log(`fc5_planted_hang_settled=${hung.settled}`)
  console.log(`fc5_planted_hang_elapsed_ms=${hung.elapsed}`)
  console.log(`fc5_absent_created=${absentFailed.created}`)
  console.log(`fc5_absent_fail_surfaced=${absentFailed.surfaced}`)
  console.log(`fc5_absent_hang_settled=${absentHung.settled}`)
  console.log(`fc5_absent_hang_elapsed_ms=${absentHung.elapsed}`)
  console.log(
    `fc5_absent_exit=${plantedExit(fc5Negative(absentFailed.created, absentFailed.surfaced, absentHung.settled, absentHung.elapsed))}`,
  )
  return plantedExit(
    fc5Negative(failed.created, failed.surfaced, hung.settled, hung.elapsed),
  )
}

async function fc5Head() {
  requireDatabase()
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const unregister = registerEditorFlush(() => new Promise(() => undefined))
  const started = Date.now()
  let created = false
  let logicError = ''
  try {
    await flushEditor(80)
    created = true
  } catch (error) {
    logicError = error instanceof Error ? error.message : 'error'
  }
  const logicElapsed = Date.now() - started
  unregister()
  console.log(`fc5_head_created=${created}`)
  console.log(`fc5_head_error=${logicError}`)
  console.log(`fc5_head_elapsed_ms=${logicElapsed}`)
  console.log(`fc5_head_within_5s=${logicElapsed < 5000}`)

  const user = await createUser('Writer')
  const session = await browser()
  const page = await session.newPage({ viewport: { width: 1280, height: 800 } })
  let mode: 'pass' | 'fail' | 'hang' = 'pass'
  const releaseHung: Array<() => void> = []
  try {
    await page.route(
      (url) => mode !== 'pass' && url.pathname.includes('/_serverFn/'),
      async (route) => {
        if (!isSaveRequest(route.request())) {
          await route.continue()
          return
        }
        if (mode === 'hang') {
          await new Promise<void>((resolve) => {
            releaseHung.push(resolve)
          })
          await route.abort().catch(() => undefined)
          return
        }
        await route.fulfill({
          status: 500,
          contentType: 'text/plain',
          body: 'Internal Server Error',
        })
      },
    )
    await signIn(page, user.user.email, user.password)
    await page.goto(`${base}/s/${user.space.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForApp(page)
    await clickNewPage(page)
    await page.locator('.doc-editor').waitFor()
    mode = 'fail'
    const marker = 'keep-fail-fc5'
    await page.locator('.doc-editor').click()
    await page.keyboard.type(marker)
    const failUrl = new URL(page.url()).pathname
    let failStart = 0
    await clickNewPage(page, () => {
      failStart = Date.now()
    })
    const failAlert = page.getByRole('alert').filter({ hasText: 'not created' })
    await failAlert.waitFor({ timeout: 8000 })
    const failElapsed = Date.now() - failStart
    const failText = (await page.locator('.doc-editor').innerText()).includes(
      marker,
    )
    const failKept = new URL(page.url()).pathname === failUrl
    console.log(`fc5_fail_elapsed_ms=${failElapsed}`)
    console.log(`fc5_fail_prompt=${failElapsed < 4000}`)
    console.log(`fc5_fail_alert=${(await failAlert.count()) > 0}`)
    console.log(`fc5_fail_text_kept=${failText}`)
    console.log(`fc5_fail_url_kept=${failKept}`)

    mode = 'hang'
    const hangMarker = 'keep-hang-fc5'
    await page.locator('.doc-editor').click()
    await page.keyboard.type(hangMarker)
    const hangUrl = new URL(page.url()).pathname
    const alert = page.getByRole('alert').filter({ hasText: 'not created' })
    let hangStart = 0
    await clickNewPage(page, () => {
      hangStart = Date.now()
    })
    await alert.waitFor({ state: 'hidden', timeout: 2000 })
    await alert.waitFor({ state: 'visible', timeout: 8000 })
    const hangElapsed = Date.now() - hangStart
    const hangText = (await page.locator('.doc-editor').innerText()).includes(
      marker,
    )
    const hangKept = new URL(page.url()).pathname === hangUrl
    console.log(`fc5_hang_elapsed_ms=${hangElapsed}`)
    console.log(
      `fc5_hang_timed_out=${hangElapsed >= 4500 && hangElapsed < 7000}`,
    )
    console.log(`fc5_hang_text_kept=${hangText}`)
    console.log(`fc5_hang_url_kept=${hangKept}`)
    const logicOk =
      !created && logicElapsed < 5000 && logicError === 'Save timed out'
    const failOk = failElapsed < 4000 && failText && failKept
    const hangOk =
      hangElapsed >= 4500 && hangElapsed < 7000 && hangText && hangKept
    return logicOk && failOk && hangOk ? 0 : 1
  } finally {
    for (const release of releaseHung) release()
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
    await session.close()
  }
}

async function fc6Tab(page: Page, inertBackground: boolean) {
  const background = inertBackground ? '<div inert>' : '<div>'
  await page.setContent(`<!doctype html>
    <div role="dialog"><input id="team-name"><button id="cancel">Cancel</button></div>
    ${background}<button id="behind">Behind</button></div>`)
  await page.locator('#team-name').focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const id = await page.evaluate(() => document.activeElement?.id ?? '')
  const inert = await page.evaluate(
    () => document.querySelector('#behind')?.parentElement?.inert === true,
  )
  return { id, inert }
}

async function fc6Planted() {
  const session = await browser()
  const page = await session.newPage()
  try {
    const open = await fc6Tab(page, false)
    const trapped = await fc6Tab(page, true)
    console.log(`fc6_planted_active=${open.id}`)
    console.log(`fc6_planted_background_inert=${open.inert}`)
    console.log(`fc6_planted_tab_reached_background=${open.id === 'behind'}`)
    console.log(`fc6_absent_active=${trapped.id}`)
    console.log(`fc6_absent_background_inert=${trapped.inert}`)
    console.log(`fc6_absent_exit=${plantedExit(trapped.id === 'behind')}`)
    return plantedExit(open.id === 'behind')
  } finally {
    await session.close()
  }
}

async function fc6Head() {
  requireDatabase()
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const user = await createUser('Switcher')
  const session = await browser()
  const page = await session.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await signIn(page, user.user.email, user.password)
    await page.goto(`${base}/s/${user.space.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForApp(page)
    await page.getByRole('button', { name: /switch space/ }).click()
    await page.getByRole('menuitem', { name: 'Create team' }).click()
    await page.getByRole('dialog').waitFor()
    const inert = await page.evaluate(() => {
      const app = document.querySelector('.app')
      return app instanceof HTMLElement && app.inert
    })
    let left = false
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') != null,
      )
      if (!inside) left = true
    }
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Shift+Tab')
      const inside = await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') != null,
      )
      if (!inside) left = true
    }
    console.log(`fc6_head_background_inert=${inert}`)
    console.log(`fc6_head_tab_left_dialog=${left}`)
    return inert && !left ? 0 : 1
  } finally {
    await session.close()
  }
}

async function measureError(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('.main')
    const block = document.querySelector('.space-error')
    if (!(main instanceof HTMLElement) || !(block instanceof HTMLElement)) {
      return { gap: -1, align: '', caret: '' }
    }
    const gap = Math.round(
      block.getBoundingClientRect().left - main.getBoundingClientRect().left,
    )
    const align = getComputedStyle(block).textAlign
    const caret = getComputedStyle(
      document.querySelector('.sw .k') as Element,
    ).color
    return { gap, align, caret }
  })
}

function fc7Negative(leftAligned: boolean, caretMatchesInk: boolean) {
  return !leftAligned && caretMatchesInk
}

async function fc7Measure(page: Page, centered: boolean, caret: string) {
  const block = centered
    ? 'max-width:720px;margin:36px auto;text-align:center'
    : 'max-width:720px;margin:36px 0;text-align:left'
  await page.setContent(`<!doctype html>
    <div class="main" style="position:relative;width:1000px">
      <div class="space-error" style="${block}">Block</div>
    </div>
    <span class="sw"><span class="k" style="color:${caret}">v</span></span>`)
  const measured = await measureError(page)
  const leftAligned = measured.gap < 2 && measured.align === 'left'
  return { measured, leftAligned }
}

async function fc7Planted() {
  const muted = tokenRgb('muted')
  const ink = tokenRgb('ink')
  const session = await browser()
  const page = await session.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    const centered = await fc7Measure(page, true, ink)
    const aligned = await fc7Measure(page, false, muted)
    const caretMatchesInk =
      normalizeColor(centered.measured.caret) === normalizeColor(ink)
    const absentMatchesInk =
      normalizeColor(aligned.measured.caret) === normalizeColor(ink)
    console.log(`fc7_planted_left_gap=${centered.measured.gap}`)
    console.log(`fc7_planted_text_align=${centered.measured.align}`)
    console.log(`fc7_planted_caret=${centered.measured.caret}`)
    console.log(`fc7_planted_muted=${muted}`)
    console.log(`fc7_planted_left_aligned=${centered.leftAligned}`)
    console.log(`fc7_planted_caret_matches_ink=${caretMatchesInk}`)
    console.log(
      `fc7_planted_caret_matches_muted=${normalizeColor(centered.measured.caret) === normalizeColor(muted)}`,
    )
    console.log(`fc7_absent_left_aligned=${aligned.leftAligned}`)
    console.log(`fc7_absent_caret=${aligned.measured.caret}`)
    console.log(
      `fc7_absent_exit=${plantedExit(fc7Negative(aligned.leftAligned, absentMatchesInk))}`,
    )
    return plantedExit(fc7Negative(centered.leftAligned, caretMatchesInk))
  } finally {
    await session.close()
  }
}

async function fc7Head() {
  requireDatabase()
  const base = assertLocalBaseUrl(
    process.env.BASE_URL ?? 'http://127.0.0.1:3000',
  )
  const muted = tokenRgb('muted')
  const user = await createUser('Layout')
  const session = await browser()
  const page = await session.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await page.route(
      (url) => isPageTreeUrl(url.href),
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Internal Server Error' }),
        })
      },
    )
    await signIn(page, user.user.email, user.password)
    await page.goto(`${base}/s/${user.space.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForApp(page)
    await page.evaluate(async () => {
      const router = (
        window as unknown as {
          __TSR_ROUTER__?: { invalidate: () => Promise<unknown> }
        }
      ).__TSR_ROUTER__
      if (router) await router.invalidate()
    })
    await page
      .getByRole('heading', { name: "Couldn't load this space." })
      .waitFor()
    const measured = await measureError(page)
    const leftAligned = measured.gap < 2 && measured.align === 'left'
    const caretMatches =
      normalizeColor(measured.caret) === normalizeColor(muted)
    const dir = join(process.cwd(), 'artifacts', 'issue18')
    await mkdir(dir, { recursive: true })
    const shot = join(dir, 'fc7-space-error.png')
    await page.screenshot({ path: shot, animations: 'disabled' })
    console.log(`fc7_head_left_gap=${measured.gap}`)
    console.log(`fc7_head_text_align=${measured.align}`)
    console.log(`fc7_head_left_aligned=${leftAligned}`)
    console.log(`fc7_head_caret=${measured.caret}`)
    console.log(`fc7_head_muted=${muted}`)
    console.log(`fc7_head_caret_matches_muted=${caretMatches}`)
    console.log(`fc7_screenshot=${shot}`)
    return leftAligned && caretMatches ? 0 : 1
  } finally {
    await session.close()
  }
}

function stepNames(text: string) {
  return [...text.matchAll(/^run_step (18-fc\d+)\b/gm)].map((match) => match[1])
}

function fc8Planted() {
  const missing = readFileSync(
    new URL('./fixtures/issue18-verify-all-missing.txt', import.meta.url),
    'utf8',
  )
  const present = readFileSync(
    new URL('./verify-all.sh', import.meta.url),
    'utf8',
  )
  const steps = stepNames(missing)
  const presentSteps = stepNames(present)
  console.log(`fc8_planted_steps=${steps.length}`)
  console.log(`fc8_planted_names=${steps.join(',')}`)
  console.log(`fc8_absent_steps=${presentSteps.length}`)
  console.log(`fc8_absent_exit=${plantedExit(presentSteps.length === 0)}`)
  return plantedExit(steps.length === 0)
}

function fc8Head() {
  const text = readFileSync(new URL('./verify-all.sh', import.meta.url), 'utf8')
  const recipes = readFileSync(
    new URL('./verify-fail-conditions.sh', import.meta.url),
    'utf8',
  )
  const steps = stepNames(text)
  const expected = [
    '18-fc1',
    '18-fc2',
    '18-fc3',
    '18-fc4',
    '18-fc5',
    '18-fc6',
    '18-fc7',
    '18-fc8',
  ]
  const missing = expected.filter((name) => !steps.includes(name))
  const recipeMissing = expected.filter((name) => !recipes.includes(`${name})`))
  console.log(`fc8_head_steps=${steps.length}`)
  console.log(`fc8_head_names=${steps.join(',')}`)
  console.log(`fc8_head_missing=${missing.join(',')}`)
  console.log(`fc8_head_recipe_missing=${recipeMissing.join(',')}`)
  return missing.length === 0 && recipeMissing.length === 0 ? 0 : 1
}

const command = process.argv[2]
const planted = process.argv[3] === 'planted'

const runs: Record<string, () => Promise<number> | number> = {
  fc1: () => (planted ? fc1Planted() : fc1Head()),
  fc2: () => (planted ? fc2Planted() : fc2Head()),
  fc3: () => (planted ? fc3Planted() : fc3Head()),
  fc4: () => (planted ? fc4Planted() : fc4Head()),
  fc5: () => (planted ? fc5Planted() : fc5Head()),
  fc6: () => (planted ? fc6Planted() : fc6Head()),
  fc7: () => (planted ? fc7Planted() : fc7Head()),
  fc8: () => (planted ? fc8Planted() : fc8Head()),
}

let code = 1
try {
  const run = command ? runs[command] : undefined
  if (!run) {
    console.log(
      'usage: issue18-fail.ts fc1|fc2|fc3|fc4|fc5|fc6|fc7|fc8 [planted]',
    )
  } else {
    code = await run()
    console.log(`${command}=${code === 0 ? 'pass' : 'fail'}`)
  }
} catch (error) {
  console.log(`error=${safeMessage(error)}`)
  if (error instanceof Error) {
    const waiting = error.message
      .split('\n')
      .find((line) => line.includes('waiting for'))
    if (waiting) console.log(waiting.trim())
  }
  code = 1
} finally {
  await closeDb().catch(() => undefined)
}
process.exit(code)
