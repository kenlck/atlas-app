import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type BrowserContext } from 'playwright'

const execFileAsync = promisify(execFile)
const BASE_URL = (process.env.BASE_URL ?? '').replace(/\/$/, '')
const PASSWORD = process.env.VERIFY_PASSWORD ?? ''

if (!BASE_URL) {
  console.error('BASE_URL is required')
  process.exit(1)
}
if (!PASSWORD) {
  console.error('VERIFY_PASSWORD is required')
  process.exit(1)
}

function ensurePgEnv() {
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE) return
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL or PGHOST is required')
    process.exit(1)
  }
  const parsed = new URL(url)
  process.env.PGHOST = parsed.hostname
  process.env.PGPORT = parsed.port || '5432'
  process.env.PGUSER = decodeURIComponent(parsed.username)
  process.env.PGPASSWORD = decodeURIComponent(parsed.password)
  process.env.PGDATABASE = parsed.pathname.replace(/^\//, '')
}

function step(label: string) {
  console.log(`STEP ${new Date().toISOString()} ${label}`)
}

function redact(text: string) {
  return text
    .replace(
      /better-auth\.session_token=[^;\s]+/g,
      'better-auth.session_token=[redacted]',
    )
    .replace(/("token"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("password"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("temporaryPassword"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
}

function assertUuid(value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value))
    throw new Error('refusing to interpolate a non-uuid')
  return value
}

function assertId(value: string) {
  if (!/^[A-Za-z0-9]{8,64}$/.test(value))
    throw new Error('refusing to interpolate an unsafe id')
  return value
}

function assertEmail(value: string) {
  if (!/^[a-z0-9.+_-]+@example\.com$/i.test(value))
    throw new Error('refusing to interpolate an unsafe email')
  return value
}

async function psql(query: string) {
  const result = await execFileAsync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-At', '-c', query],
    {
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    },
  )
  return result.stdout.trimEnd()
}

async function curl(args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-curl-'))
  const headers = join(dir, 'headers')
  const body = join(dir, 'body')
  await execFileAsync('curl', ['-sS', '-D', headers, '-o', body, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  })
  const headerText = await readFile(headers, 'utf8')
  const bodyText = await readFile(body, 'utf8')
  await rm(dir, { recursive: true, force: true })
  return { headers: headerText, body: bodyText }
}

async function dump(label: string, args: string[]) {
  step(label)
  const result = await curl(args)
  console.log(redact(result.headers).trimEnd())
  console.log(redact(result.body).trimEnd())
  const status = result.headers.match(/^HTTP\/\S+\s+(\d+)/m)?.[1] ?? ''
  console.log(`parsed_status=${status}`)
  return { status, body: result.body, headers: result.headers }
}

async function cookieJar(context: BrowserContext, dir: string, name: string) {
  const jar = join(dir, name)
  const cookies = await context.cookies()
  const lines = ['# Netscape HTTP Cookie File']
  for (const cookie of cookies) {
    lines.push(
      [
        cookie.domain,
        cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
        cookie.path,
        cookie.secure ? 'TRUE' : 'FALSE',
        String(
          cookie.expires > 0
            ? Math.floor(cookie.expires)
            : Math.floor(Date.now() / 1000) + 86400,
        ),
        cookie.name,
        cookie.value,
      ].join('\t'),
    )
  }
  await writeFile(jar, `${lines.join('\n')}\n`)
  return jar
}

async function signUp(context: BrowserContext, name: string, email: string) {
  step(`sign up ${name}`)
  const response = await context.request.post(
    `${BASE_URL}/api/auth/sign-up/email`,
    {
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
      data: { name, email, password: PASSWORD },
    },
  )
  const body = await response.text()
  console.log(`HTTP ${response.status()}`)
  console.log(redact(body))
  if (response.status() !== 200)
    throw new Error(`sign-up ${name} status ${response.status()}`)
  const parsed = JSON.parse(body) as { user?: { id?: string; email?: string } }
  const id = parsed.user?.id
  if (!id) throw new Error('sign-up missing id')
  console.log(`user_id=${id} email=${parsed.user?.email}`)
  return { id, email: parsed.user?.email ?? email }
}

async function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(value))
  return path
}

async function createTeam(jar: string, dir: string, name: string) {
  const payload = await writeJson(dir, `team-${name}.json`, { name })
  const result = await dump(`create team ${name}`, [
    '-b',
    jar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${payload}`,
    `${BASE_URL}/api/atlas/teams`,
  ])
  if (result.status !== '201')
    throw new Error(`create team status ${result.status}`)
  return JSON.parse(result.body) as {
    id: string
    spaceId: string
    name: string
  }
}

async function insertPage(spaceId: string, userId: string, title: string) {
  const id = crypto.randomUUID()
  await psql(
    `INSERT INTO page (id, space_id, title, body, body_text, position, created_by, updated_by, created_at, updated_at) VALUES ('${assertUuid(id)}', '${assertUuid(spaceId)}', '${title.replace(/'/g, '')}', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, '', 1000, '${assertId(userId)}', '${assertId(userId)}', now(), now())`,
  )
  return id
}

async function fail1(dir: string) {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ownerCtx = await browser.newContext()
  const invitedCtx = await browser.newContext()
  const imposterCtx = await browser.newContext()
  await signUp(ownerCtx, 'Owner', `owner.${stamp}@example.com`)
  const invited = await signUp(
    invitedCtx,
    'Invited',
    `invited.${stamp}@example.com`,
  )
  const ownerJar = await cookieJar(ownerCtx, dir, 'owner.txt')
  const invitedJar = await cookieJar(invitedCtx, dir, 'invited.txt')
  const team = await createTeam(ownerJar, dir, 'North')
  step('team_invite columns')
  const columns = await psql(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'team_invite' ORDER BY 1",
  )
  console.log(columns)
  const before = await psql('SELECT count(*) FROM team_invite')
  console.log(`invite_count_before=${before}`)
  const missing = await writeJson(dir, 'missing.json', {
    email: `nobody.${stamp}@example.com`,
  })
  const missed = await dump('lookup missing email', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${missing}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites/lookup`,
  ])
  const afterMissing = await psql('SELECT count(*) FROM team_invite')
  console.log(`invite_count_after_missing_lookup=${afterMissing}`)
  console.log(`lookup_created_invite=${before !== afterMissing}`)
  if (
    missed.status !== '404' ||
    !missed.body.includes('No account with that email.')
  ) {
    throw new Error('missing lookup did not return the no-account 404')
  }
  const lookupPayload = await writeJson(dir, 'lookup.json', {
    email: invited.email,
  })
  const found = await dump('lookup existing account', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${lookupPayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites/lookup`,
  ])
  const afterLookup = await psql('SELECT count(*) FROM team_invite')
  console.log(`invite_count_after_found_lookup=${afterLookup}`)
  if (found.status !== '200') throw new Error('lookup failed')
  const foundUser = JSON.parse(found.body) as { user: { id: string } }
  console.log(`looked_up_id=${foundUser.user.id}`)
  console.log(`looked_up_matches_account=${foundUser.user.id === invited.id}`)
  const emailOnly = await writeJson(dir, 'email-only.json', {
    email: invited.email,
  })
  const rejected = await dump('create invite with email and no account id', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${emailOnly}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const afterEmailOnly = await psql('SELECT count(*) FROM team_invite')
  console.log(`invite_count_after_email_only=${afterEmailOnly}`)
  if (rejected.status !== '400')
    throw new Error('email-only invite was not rejected')
  const invitePayload = await writeJson(dir, 'invite.json', {
    userId: foundUser.user.id,
  })
  const created = await dump('create invite by account id', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${invitePayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  if (created.status !== '201') throw new Error('invite create failed')
  const invite = JSON.parse(created.body) as {
    id: string
    inviteeUserId: string
  }
  const stored = await psql(
    `SELECT invitee_user_id || '|' || status FROM team_invite WHERE id = '${assertUuid(invite.id)}'`,
  )
  console.log(`stored_invitee_and_status=${stored}`)
  const renamed = `renamed.${stamp}@example.com`
  await psql(
    `UPDATE "user" SET email = '${assertEmail(renamed)}' WHERE id = '${assertId(invited.id)}'`,
  )
  console.log('renamed invited account email in the user row')
  const imposter = await signUp(imposterCtx, 'Imposter', invited.email)
  const imposterJar = await cookieJar(imposterCtx, dir, 'imposter.txt')
  const imposterList = await dump('imposter lists invitations', [
    '-b',
    imposterJar,
    `${BASE_URL}/api/atlas/invites`,
  ])
  console.log(
    `imposter_invite_count=${JSON.parse(imposterList.body).invites.length}`,
  )
  const imposterAccept = await dump('imposter accepts by old email', [
    '-b',
    imposterJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  const imposterDecline = await dump('imposter declines by old email', [
    '-b',
    imposterJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/decline`,
  ])
  const still = await psql(
    `SELECT invitee_user_id || '|' || status FROM team_invite WHERE id = '${assertUuid(invite.id)}'`,
  )
  console.log(`invite_after_imposter=${still}`)
  const originalList = await dump('original account lists invitations', [
    '-b',
    invitedJar,
    `${BASE_URL}/api/atlas/invites`,
  ])
  const originalAccept = await dump('original account accepts by stored id', [
    '-b',
    invitedJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  const member = await psql(
    `SELECT user_id || '|' || role::text FROM team_member WHERE team_id = '${assertUuid(team.id)}' AND user_id = '${assertId(invited.id)}'`,
  )
  const imposterMember = await psql(
    `SELECT count(*) FROM team_member WHERE team_id = '${assertUuid(team.id)}' AND user_id = '${assertId(imposter.id)}'`,
  )
  console.log(`original_membership=${member}`)
  console.log(`imposter_membership_count=${imposterMember}`)
  if (
    imposterAccept.status !== '404' ||
    imposterDecline.status !== '404' ||
    originalAccept.status !== '200'
  ) {
    throw new Error('accept matching did not follow the stored account id')
  }
  if (!originalList.body.includes(invite.id))
    throw new Error('original account lost the invite')
  await browser.close()
}

async function fail2(dir: string) {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ownerCtx = await browser.newContext()
  const invitedCtx = await browser.newContext()
  const otherCtx = await browser.newContext()
  await signUp(ownerCtx, 'Owner', `owner2.${stamp}@example.com`)
  const invited = await signUp(
    invitedCtx,
    'Invited',
    `invited2.${stamp}@example.com`,
  )
  await signUp(otherCtx, 'Other', `other2.${stamp}@example.com`)
  const ownerJar = await cookieJar(ownerCtx, dir, 'owner.txt')
  const invitedJar = await cookieJar(invitedCtx, dir, 'invited.txt')
  const otherJar = await cookieJar(otherCtx, dir, 'other.txt')
  const team = await createTeam(ownerJar, dir, 'Gate')
  const payload = await writeJson(dir, 'invite.json', { userId: invited.id })
  const created = await dump('owner creates invite', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${payload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const invite = JSON.parse(created.body) as { id: string }
  const otherAccept = await dump('other account accepts', [
    '-b',
    otherJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  const otherDecline = await dump('other account declines', [
    '-b',
    otherJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/decline`,
  ])
  const ownerAccept = await dump('owner accepts someone elses invite', [
    '-b',
    ownerJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  const status = await psql(
    `SELECT status FROM team_invite WHERE id = '${assertUuid(invite.id)}'`,
  )
  console.log(`status_after_wrong_accounts=${status}`)
  const decline = await dump('invited account declines', [
    '-b',
    invitedJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/decline`,
  ])
  const second = await dump('invited account accepts after decline', [
    '-b',
    invitedJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  if (
    otherAccept.status !== '404' ||
    otherDecline.status !== '404' ||
    ownerAccept.status !== '404'
  ) {
    throw new Error('wrong account was able to answer the invite')
  }
  if (decline.status !== '200' || second.status !== '404')
    throw new Error('invited account flow failed')
  await browser.close()
}

async function fail3(dir: string) {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ownerCtx = await browser.newContext()
  const outsiderCtx = await browser.newContext()
  const owner = await signUp(ownerCtx, 'Owner', `owner3.${stamp}@example.com`)
  await signUp(outsiderCtx, 'Outsider', `outsider3.${stamp}@example.com`)
  const ownerJar = await cookieJar(ownerCtx, dir, 'owner.txt')
  const outsiderJar = await cookieJar(outsiderCtx, dir, 'outsider.txt')
  const team = await createTeam(ownerJar, dir, 'Hidden')
  const pageId = await insertPage(team.spaceId, owner.id, 'Secret')
  const pageUrl = `${BASE_URL}/s/${team.spaceId}/p/${pageId}`
  const spaceUrl = `${BASE_URL}/s/${team.spaceId}`
  const missingPage = await dump('missing page', [
    '-b',
    ownerJar,
    `${BASE_URL}/s/${team.spaceId}/p/missing-page`,
  ])
  const deniedPage = await dump('non-member team page', [
    '-b',
    outsiderJar,
    pageUrl,
  ])
  const missingSpace = await dump('missing space', [
    '-b',
    ownerJar,
    `${BASE_URL}/s/missing-space`,
  ])
  const deniedSpace = await dump('non-member team page list', [
    '-b',
    outsiderJar,
    spaceUrl,
  ])
  const missingTeam = await dump('missing team API', [
    '-b',
    ownerJar,
    `${BASE_URL}/api/atlas/teams/missing-team-id`,
  ])
  const deniedTeam = await dump('non-member team API', [
    '-b',
    outsiderJar,
    `${BASE_URL}/api/atlas/teams/${team.id}`,
  ])
  const ownerPage = await dump('member team page', ['-b', ownerJar, pageUrl])
  console.log(`missing_page_status=${missingPage.status}`)
  console.log(`non_member_page_status=${deniedPage.status}`)
  console.log(`page_status_equal=${missingPage.status === deniedPage.status}`)
  console.log(
    `missing_page_not_found=${missingPage.body.includes('Page not found.')}`,
  )
  console.log(
    `non_member_page_not_found=${deniedPage.body.includes('Page not found.')}`,
  )
  console.log(`missing_space_status=${missingSpace.status}`)
  console.log(`non_member_space_status=${deniedSpace.status}`)
  console.log(
    `space_status_equal=${missingSpace.status === deniedSpace.status}`,
  )
  console.log(
    `non_member_space_not_found=${deniedSpace.body.includes('Page not found.')}`,
  )
  console.log(`missing_team_status=${missingTeam.status}`)
  console.log(`non_member_team_status=${deniedTeam.status}`)
  console.log(`team_status_equal=${missingTeam.status === deniedTeam.status}`)
  console.log(
    `team_body_equal=${missingTeam.body.trim() === deniedTeam.body.trim()}`,
  )
  console.log(`owner_page_status=${ownerPage.status}`)
  if (
    deniedPage.status !== '404' ||
    deniedSpace.status !== '404' ||
    deniedTeam.status !== '404'
  ) {
    throw new Error('non-member did not get 404')
  }
  if (
    missingPage.status !== deniedPage.status ||
    missingTeam.body.trim() !== deniedTeam.body.trim()
  ) {
    throw new Error('non-member response differed from a missing resource')
  }
  await browser.close()
}

async function fail4(dir: string) {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ownerCtx = await browser.newContext()
  const memberCtx = await browser.newContext()
  const owner = await signUp(ownerCtx, 'Owner', `owner4.${stamp}@example.com`)
  const member = await signUp(
    memberCtx,
    'Member',
    `member4.${stamp}@example.com`,
  )
  const ownerJar = await cookieJar(ownerCtx, dir, 'owner.txt')
  const memberJar = await cookieJar(memberCtx, dir, 'member.txt')
  const team = await createTeam(ownerJar, dir, 'Editors')
  const invitePayload = await writeJson(dir, 'invite.json', {
    userId: member.id,
  })
  const created = await dump('invite member', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${invitePayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const invite = JSON.parse(created.body) as { id: string }
  await dump('member accepts', [
    '-b',
    memberJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  const pageId = await insertPage(team.spaceId, owner.id, 'Shared')
  const pageUrl = `${BASE_URL}/s/${team.spaceId}/p/${pageId}`
  const before = await psql(
    `SELECT title || '|' || body_text FROM page WHERE id = '${assertUuid(pageId)}'`,
  )
  console.log(`page_before=${before}`)
  const open = await dump('member reads page before removal', [
    '-b',
    memberJar,
    pageUrl,
  ])
  const tab = await memberCtx.newPage()
  step('open editor tab')
  await tab.goto(pageUrl, { waitUntil: 'networkidle' })
  await tab.locator('#page-title').waitFor()
  console.log(`open_tab_url_path=${new URL(tab.url()).pathname}`)
  await dump('owner removes member', [
    '-b',
    ownerJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/${team.id}/members/${member.id}`,
  ])
  const read = await dump('removed member reads page', [
    '-b',
    memberJar,
    pageUrl,
  ])
  const savePayload = await writeJson(dir, 'save.json', {
    pageId,
    title: 'Stolen',
    body: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  const save = await dump('removed member saves via editor endpoint', [
    '-b',
    memberJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${savePayload}`,
    '-X',
    'POST',
    `${BASE_URL}/api/pages/save`,
  ])
  step('open tab save')
  const tabSave = await tab.evaluate(
    async (payload) => {
      const response = await fetch('/api/pages/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.text() }
    },
    {
      pageId,
      title: 'Stolen from open tab',
      body: { type: 'doc', content: [] },
    },
  )
  console.log(`open_tab_save_status=${tabSave.status}`)
  console.log(redact(tabSave.body))
  const after = await psql(
    `SELECT title || '|' || body_text FROM page WHERE id = '${assertUuid(pageId)}'`,
  )
  console.log(`page_after=${after}`)
  console.log(`content_unchanged=${before === after}`)
  console.log(`read_before_status=${open.status}`)
  if (
    open.status !== '200' ||
    read.status !== '404' ||
    save.status !== '404' ||
    tabSave.status !== 404
  ) {
    throw new Error('removal did not apply on the next request')
  }
  if (before !== after) throw new Error('removed member changed the page')
  await browser.close()
}

async function fail5(dir: string) {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ownerCtx = await browser.newContext()
  const memberCtx = await browser.newContext()
  const extraCtx = await browser.newContext()
  await signUp(ownerCtx, 'Owner', `owner5.${stamp}@example.com`)
  const member = await signUp(
    memberCtx,
    'Member',
    `member5.${stamp}@example.com`,
  )
  const extra = await signUp(extraCtx, 'Extra', `extra5.${stamp}@example.com`)
  const ownerJar = await cookieJar(ownerCtx, dir, 'owner.txt')
  const memberJar = await cookieJar(memberCtx, dir, 'member.txt')
  const team = await createTeam(ownerJar, dir, 'Roles')
  const invitePayload = await writeJson(dir, 'invite.json', {
    userId: member.id,
  })
  const created = await dump('owner invites member', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${invitePayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const invite = JSON.parse(created.body) as { id: string }
  await dump('member accepts', [
    '-b',
    memberJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  const before = await psql('SELECT count(*) FROM team_invite')
  const lookupPayload = await writeJson(dir, 'lookup.json', {
    email: extra.email,
  })
  const lookup = await dump('member lookup', [
    '-b',
    memberJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${lookupPayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites/lookup`,
  ])
  const createPayload = await writeJson(dir, 'create.json', {
    userId: extra.id,
  })
  const create = await dump('member invite', [
    '-b',
    memberJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${createPayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const remove = await dump('member removes owner', [
    '-b',
    memberJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/${team.id}/members/${assertId(await psql(`SELECT user_id FROM team_member WHERE team_id = '${assertUuid(team.id)}' AND role = 'owner'`))}`,
  ])
  const deleted = await dump('member deletes team', [
    '-b',
    memberJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/${team.id}`,
  ])
  const after = await psql('SELECT count(*) FROM team_invite')
  const still = await dump('owner still reads team', [
    '-b',
    ownerJar,
    `${BASE_URL}/api/atlas/teams/${team.id}`,
  ])
  const ownerLookup = await dump('owner lookup still works', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${lookupPayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites/lookup`,
  ])
  console.log(`invite_count_before=${before}`)
  console.log(`invite_count_after=${after}`)
  if (
    [lookup.status, create.status, remove.status, deleted.status].some(
      (status) => status !== '403',
    )
  ) {
    throw new Error('member was not forbidden')
  }
  if (
    before !== after ||
    still.status !== '200' ||
    ownerLookup.status !== '200'
  ) {
    throw new Error('member action changed owner access')
  }
  await browser.close()
}

async function fail6(dir: string) {
  const stamp = Date.now()
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ownerCtx = await browser.newContext()
  const teammateCtx = await browser.newContext()
  const outsiderCtx = await browser.newContext()
  const owner = await signUp(ownerCtx, 'Sam', `sam.${stamp}@example.com`)
  const teammate = await signUp(
    teammateCtx,
    'Ada West',
    `ada.${stamp}@example.com`,
  )
  const outsider = await signUp(
    outsiderCtx,
    'Samantha',
    `samantha.${stamp}@example.com`,
  )
  const ownerJar = await cookieJar(ownerCtx, dir, 'owner.txt')
  const teammateJar = await cookieJar(teammateCtx, dir, 'teammate.txt')
  const outsiderJar = await cookieJar(outsiderCtx, dir, 'outsider.txt')
  const personal = await psql(
    `SELECT id FROM space WHERE kind = 'personal' AND owner_user_id = '${assertId(owner.id)}'`,
  )
  const team = await createTeam(ownerJar, dir, 'Mentions')
  const invitePayload = await writeJson(dir, 'invite.json', {
    userId: teammate.id,
  })
  const created = await dump('invite teammate', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${invitePayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const invite = JSON.parse(created.body) as { id: string }
  await dump('teammate accepts', [
    '-b',
    teammateJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${invite.id}/accept`,
  ])
  const personalList = await dump('personal mention list', [
    '-b',
    ownerJar,
    `${BASE_URL}/api/atlas/spaces/${personal}/mentionables?q=Sam`,
  ])
  const teamList = await dump('team mention list', [
    '-b',
    teammateJar,
    `${BASE_URL}/api/atlas/spaces/${team.spaceId}/mentionables`,
  ])
  const denied = await dump('outsider mention list', [
    '-b',
    outsiderJar,
    `${BASE_URL}/api/atlas/spaces/${team.spaceId}/mentionables`,
  ])
  const personalUsers = JSON.parse(personalList.body) as {
    users: Array<{ id: string; name: string }>
  }
  const teamUsers = JSON.parse(teamList.body) as {
    users: Array<{ id: string; name: string }>
  }
  console.log(
    `personal_ids=${personalUsers.users.map((user) => user.id).join(',')}`,
  )
  console.log(
    `personal_only_self=${personalUsers.users.length === 1 && personalUsers.users[0]?.id === owner.id}`,
  )
  console.log(
    `team_ids=${teamUsers.users
      .map((user) => user.id)
      .sort()
      .join(',')}`,
  )
  console.log(
    `team_includes_outsider=${teamUsers.users.some((user) => user.id === outsider.id)}`,
  )
  console.log(`team_body_has_at=${teamList.body.includes('@')}`)
  console.log(`outsider_status=${denied.status}`)
  if (!personalUsers.users.every((user) => user.id === owner.id))
    throw new Error('personal list was not self-only')
  if (
    teamUsers.users.some((user) => user.id === outsider.id) ||
    teamList.body.includes('@')
  ) {
    throw new Error('team mention list leaked someone or an email')
  }
  if (denied.status !== '404')
    throw new Error('outsider mention list was not 404')
  await browser.close()
}

async function main() {
  ensurePgEnv()
  const which = process.argv[2]
  const dir = await mkdtemp(join(tmpdir(), 'atlas-team-evidence-'))
  console.log(`DATABASE_URL=${process.env.DATABASE_URL ? 'set' : 'unset'}`)
  console.log(
    `ADMIN_API_SECRET=${process.env.ADMIN_API_SECRET ? 'set' : 'unset'}`,
  )
  console.log(
    `BETTER_AUTH_SECRET=${process.env.BETTER_AUTH_SECRET ? 'set' : 'unset'}`,
  )
  try {
    if (which === '1') await fail1(dir)
    else if (which === '2') await fail2(dir)
    else if (which === '3') await fail3(dir)
    else if (which === '4') await fail4(dir)
    else if (which === '5') await fail5(dir)
    else if (which === '6') await fail6(dir)
    else {
      console.error('usage: team-fail-evidence.ts [1|2|3|4|5|6]')
      process.exit(2)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'evidence failed')
  process.exit(1)
})
