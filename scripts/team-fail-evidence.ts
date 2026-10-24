import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

function serverFnPayload(data: unknown) {
  let next = 0
  const node = (value: unknown): unknown => {
    if (value === null) return { t: 2, s: 0 }
    if (typeof value === 'string') return { t: 1, s: value }
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

async function loadServerFns() {
  const dir = '.output/server/_ssr'
  const files = (await readdir(dir)).filter(
    (name) => name.startsWith('fns-') && name.endsWith('.mjs'),
  )
  const pattern =
    /var (\w+)_createServerFn_handler = createServerRpc\(\{\s*id: "([a-f0-9]{64})"[\s\S]*?createServerFn\(\{ method: "(GET|POST)" \}\)/g
  const found = new Map<string, { id: string; method: 'GET' | 'POST' }>()
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    if (!text.includes('createServerRpc({')) continue
    for (const match of text.matchAll(pattern)) {
      const name = match[1]
      const id = match[2]
      const method = match[3]
      if (!name || !id || (method !== 'GET' && method !== 'POST')) continue
      const previous = found.get(name)
      if (previous && previous.id !== id) {
        throw new Error(`server function ${name} has two ids in the build`)
      }
      found.set(name, { id, method })
    }
  }
  if (!found.has('fetchPage') || !found.has('savePageFn')) {
    throw new Error('server function ids were not in the build')
  }
  return found
}

function serverFn(
  fns: Map<string, { id: string; method: 'GET' | 'POST' }>,
  name: string,
) {
  const fn = fns.get(name)
  if (!fn) throw new Error(`server function ${name} was not in the build`)
  return fn
}

async function callServerFn(
  label: string,
  jar: string,
  dir: string,
  file: string,
  fn: { id: string; method: 'GET' | 'POST' },
  data: Record<string, unknown>,
) {
  const payload = JSON.stringify(serverFnPayload({ data }))
  if (fn.method === 'GET') {
    return dump(label, [
      '-b',
      jar,
      '-H',
      'x-tsr-serverFn: true',
      '-H',
      `origin: ${BASE_URL}`,
      `${BASE_URL}/_serverFn/${fn.id}?payload=${encodeURIComponent(payload)}`,
    ])
  }
  const path = join(dir, file)
  await writeFile(path, payload)
  return dump(label, [
    '-b',
    jar,
    '-H',
    'x-tsr-serverFn: true',
    '-H',
    `origin: ${BASE_URL}`,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${path}`,
    '-X',
    'POST',
    `${BASE_URL}/_serverFn/${fn.id}`,
  ])
}

function expectSame404(
  label: string,
  missing: { status: string; body: string },
  denied: { status: string; body: string },
) {
  const bodyEqual = missing.body.trim() === denied.body.trim()
  const forbidden =
    denied.body.includes('Forbidden') || missing.body.includes('Forbidden')
  console.log(`${label}_missing_status=${missing.status}`)
  console.log(`${label}_non_member_status=${denied.status}`)
  console.log(`${label}_status_equal=${missing.status === denied.status}`)
  console.log(`${label}_body_equal=${bodyEqual}`)
  console.log(`${label}_has_forbidden=${forbidden}`)
  if (
    missing.status !== '404' ||
    denied.status !== '404' ||
    !bodyEqual ||
    forbidden
  ) {
    throw new Error(`${label} was not the same 404 as a missing resource`)
  }
}

function grepReport(label: string, body: string, needle: string) {
  const count = body.split(needle).length - 1
  console.log(`${label}_count=${count}`)
  let from = 0
  let shown = 0
  while (shown < 6) {
    const at = body.indexOf(needle, from)
    if (at < 0) break
    const start = Math.max(0, at - 48)
    const end = Math.min(body.length, at + needle.length + 48)
    console.log(
      `${label}_window=${JSON.stringify(redact(body.slice(start, end)))}`,
    )
    from = at + needle.length
    shown += 1
  }
  return count
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
  const fns = await loadServerFns()
  const saveBody = {
    pageId,
    title: 'Stolen',
    body: { type: 'doc', content: [{ type: 'paragraph' }] },
  }
  const missingSaveBody = { ...saveBody, pageId: 'missing-page' }
  const savePayload = await writeJson(dir, 'save.json', saveBody)
  const missingSavePayload = await writeJson(
    dir,
    'save-missing.json',
    missingSaveBody,
  )
  const missingSave = await dump('missing page save', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${missingSavePayload}`,
    '-X',
    'POST',
    `${BASE_URL}/api/pages/save`,
  ])
  const deniedSave = await dump('non-member page save', [
    '-b',
    outsiderJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${savePayload}`,
    '-X',
    'POST',
    `${BASE_URL}/api/pages/save`,
  ])
  const lookupBody = { email: `outsider3.${stamp}@example.com` }
  const lookupPayload = await writeJson(dir, 'lookup.json', lookupBody)
  const missingLookup = await dump('missing team invite lookup', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${lookupPayload}`,
    `${BASE_URL}/api/atlas/teams/missing-team-id/invites/lookup`,
  ])
  const deniedLookup = await dump('non-member invite lookup', [
    '-b',
    outsiderJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${lookupPayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites/lookup`,
  ])
  const inviteBody = { userId: owner.id }
  const invitePayload = await writeJson(dir, 'invite.json', inviteBody)
  const missingInvite = await dump('missing team send invite', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${invitePayload}`,
    `${BASE_URL}/api/atlas/teams/missing-team-id/invites`,
  ])
  const deniedInvite = await dump('non-member send invite', [
    '-b',
    outsiderJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${invitePayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const missingRemove = await dump('missing team remove member', [
    '-b',
    ownerJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/missing-team-id/members/${owner.id}`,
  ])
  const deniedRemove = await dump('non-member remove member', [
    '-b',
    outsiderJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/${team.id}/members/${owner.id}`,
  ])
  const pageDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
  const fnPairs: Array<
    [
      string,
      string,
      { id: string; method: 'GET' | 'POST' },
      Record<string, unknown>,
      Record<string, unknown>,
    ]
  > = [
    [
      'fetchPageTree',
      'page tree',
      serverFn(fns, 'fetchPageTree'),
      { spaceId: 'missing-space' },
      { spaceId: team.spaceId },
    ],
    [
      'fetchPage',
      'page read',
      serverFn(fns, 'fetchPage'),
      { pageId: 'missing-page' },
      { pageId },
    ],
    [
      'createPageFn',
      'create page',
      serverFn(fns, 'createPageFn'),
      { spaceId: 'missing-space', parentId: null, title: 'Nope' },
      { spaceId: team.spaceId, parentId: null, title: 'Nope' },
    ],
    [
      'renamePageFn',
      'rename page',
      serverFn(fns, 'renamePageFn'),
      { pageId: 'missing-page', title: 'Stolen' },
      { pageId, title: 'Stolen' },
    ],
    [
      'savePageFn',
      'save page',
      serverFn(fns, 'savePageFn'),
      { pageId: 'missing-page', title: 'Stolen', body: pageDoc },
      { pageId, title: 'Stolen', body: pageDoc },
    ],
    [
      'movePageFn',
      'move page',
      serverFn(fns, 'movePageFn'),
      { pageId: 'missing-page', parentId: null },
      { pageId, parentId: null },
    ],
    [
      'archivePageFn',
      'delete page',
      serverFn(fns, 'archivePageFn'),
      { pageId: 'missing-page' },
      { pageId },
    ],
    [
      'fetchTeamSettings',
      'list members',
      serverFn(fns, 'fetchTeamSettings'),
      { spaceId: 'missing-space', screen: 'members' },
      { spaceId: team.spaceId, screen: 'members' },
    ],
    [
      'fetchMentionCandidates',
      'mention list',
      serverFn(fns, 'fetchMentionCandidates'),
      { spaceId: 'missing-space', mentionQuery: '' },
      { spaceId: team.spaceId, mentionQuery: '' },
    ],
    [
      'lookupAccountFn',
      'invite lookup',
      serverFn(fns, 'lookupAccountFn'),
      {
        teamId: 'missing-team',
        email: `outsider3.${stamp}@example.com`,
        screen: 'lookup',
      },
      {
        teamId: team.id,
        email: `outsider3.${stamp}@example.com`,
        screen: 'lookup',
      },
    ],
    [
      'createInviteFn',
      'send invite',
      serverFn(fns, 'createInviteFn'),
      { teamId: 'missing-team', userId: owner.id },
      { teamId: team.id, userId: owner.id },
    ],
    [
      'removeMemberFn',
      'remove member',
      serverFn(fns, 'removeMemberFn'),
      { teamId: 'missing-team', userId: owner.id },
      { teamId: team.id, userId: owner.id },
    ],
  ]
  const fnResults: Array<
    [string, { status: string; body: string }, { status: string; body: string }]
  > = []
  for (const [name, label, fn, missingData, deniedData] of fnPairs) {
    const missing = await callServerFn(
      `missing ${label} serverFn ${name}`,
      ownerJar,
      dir,
      `${name}-missing.json`,
      fn,
      missingData,
    )
    const denied = await callServerFn(
      `non-member ${label} serverFn ${name}`,
      outsiderJar,
      dir,
      `${name}-denied.json`,
      fn,
      deniedData,
    )
    fnResults.push([name, missing, denied])
  }
  const missingDelete = await dump('missing team delete', [
    '-b',
    ownerJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/missing-team-id`,
  ])
  const deniedDelete = await dump('non-member delete team', [
    '-b',
    outsiderJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/${team.id}`,
  ])
  const missingDeleteFn = await callServerFn(
    'missing delete team serverFn deleteTeamFn',
    ownerJar,
    dir,
    'delete-team-missing.json',
    serverFn(fns, 'deleteTeamFn'),
    { teamId: 'missing-team' },
  )
  const deniedDeleteFn = await callServerFn(
    'non-member delete team serverFn deleteTeamFn',
    outsiderJar,
    dir,
    'delete-team-denied.json',
    serverFn(fns, 'deleteTeamFn'),
    { teamId: team.id },
  )
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
  expectSame404('save', missingSave, deniedSave)
  expectSame404('invite_lookup', missingLookup, deniedLookup)
  expectSame404('send_invite', missingInvite, deniedInvite)
  expectSame404('remove_member', missingRemove, deniedRemove)
  expectSame404('delete_team', missingDelete, deniedDelete)
  expectSame404('delete_team_serverfn', missingDeleteFn, deniedDeleteFn)
  for (const [name, missing, denied] of fnResults) {
    expectSame404(name, missing, denied)
  }
  const still = await psql(
    `SELECT title || '|' || coalesce(archived_at::text, '') FROM page WHERE id = '${assertUuid(pageId)}'`,
  )
  console.log(`page_after_denied_writes=${still}`)
  if (!still.startsWith('Secret|')) {
    throw new Error('non-member write changed the page')
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
  await tab.locator('.doc-editor').waitFor()
  console.log(`open_tab_url_path=${new URL(tab.url()).pathname}`)
  console.log(
    `open_tab_editor_ready=${(await tab.locator('.doc-editor').count()) === 1}`,
  )
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
  const fns = await loadServerFns()
  const saveFn = serverFn(fns, 'savePageFn')
  step('type in the open editor so its autosave fires')
  const autosave = tab.waitForResponse(
    (response) =>
      response.url().includes(`/_serverFn/${saveFn.id}`) &&
      response.request().method() === 'POST',
    { timeout: 10000 },
  )
  await tab.locator('.doc-editor').click()
  await tab.keyboard.type('kept')
  const autosaveResponse = await autosave
  const autosaveHeaders = await autosaveResponse.allHeaders()
  const autosaveBody = await autosaveResponse.text()
  console.log(`editor_autosave_method=${autosaveResponse.request().method()}`)
  console.log(
    `editor_autosave_path=${new URL(autosaveResponse.url()).pathname}`,
  )
  console.log('editor_autosave_request_begin')
  console.log(redact(autosaveResponse.request().postData() ?? ''))
  console.log('editor_autosave_request_end')
  console.log(`editor_autosave_status=${autosaveResponse.status()}`)
  console.log('editor_autosave_response_headers_begin')
  for (const [key, value] of Object.entries(autosaveHeaders)) {
    if (key.toLowerCase() === 'set-cookie') {
      console.log(`${key}: [redacted]`)
      continue
    }
    console.log(`${key}: ${redact(value)}`)
  }
  console.log('editor_autosave_response_headers_end')
  console.log('editor_autosave_response_begin')
  console.log(redact(autosaveBody))
  console.log('editor_autosave_response_end')
  const missingRead = await callServerFn(
    'missing page server-function read',
    memberJar,
    dir,
    'fetch-page-missing.json',
    serverFn(fns, 'fetchPage'),
    { pageId: 'missing-page' },
  )
  const removedRead = await callServerFn(
    'removed member server-function read',
    memberJar,
    dir,
    'fetch-page-removed.json',
    serverFn(fns, 'fetchPage'),
    { pageId },
  )
  const after = await psql(
    `SELECT title || '|' || body_text FROM page WHERE id = '${assertUuid(pageId)}'`,
  )
  console.log(`page_after=${after}`)
  console.log(`content_unchanged=${before === after}`)
  console.log(`read_before_status=${open.status}`)
  console.log(`editor_typed_kept=${after.includes('kept')}`)
  console.log(`fetchPage_missing_status=${missingRead.status}`)
  console.log(`fetchPage_removed_status=${removedRead.status}`)
  console.log(
    `fetchPage_status_equal=${missingRead.status === removedRead.status}`,
  )
  console.log(
    `fetchPage_body_equal=${missingRead.body.trim() === removedRead.body.trim()}`,
  )
  if (
    missingRead.status !== '404' ||
    removedRead.status !== '404' ||
    missingRead.body.trim() !== removedRead.body.trim()
  ) {
    throw new Error(
      'removed member server-function read was not a missing-page 404',
    )
  }
  if (
    open.status !== '200' ||
    read.status !== '404' ||
    save.status !== '404' ||
    autosaveResponse.status() !== 404
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
  const extraJar = await cookieJar(extraCtx, dir, 'extra.txt')
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
  const extraInvitePayload = await writeJson(dir, 'extra-invite.json', {
    userId: extra.id,
  })
  const extraCreated = await dump('owner invites extra member', [
    '-b',
    ownerJar,
    '-H',
    'content-type: application/json',
    '--data-binary',
    `@${extraInvitePayload}`,
    `${BASE_URL}/api/atlas/teams/${team.id}/invites`,
  ])
  const extraInvite = JSON.parse(extraCreated.body) as { id: string }
  await dump('extra member accepts', [
    '-b',
    extraJar,
    '-X',
    'POST',
    `${BASE_URL}/api/atlas/invites/${extraInvite.id}/accept`,
  ])
  const before = await psql('SELECT count(*) FROM team_invite')
  const teamId = assertUuid(team.id)
  const membersBefore = await psql(
    `SELECT count(*) FROM team_member WHERE team_id = '${teamId}'`,
  )
  const invitesBefore = await psql(
    `SELECT count(*) FROM team_invite WHERE team_id = '${teamId}'`,
  )
  console.log(`team_member_count_before=${membersBefore}`)
  console.log(`team_invite_count_before=${invitesBefore}`)
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
  const removeOther = await dump('member removes another member', [
    '-b',
    memberJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/${team.id}/members/${assertId(extra.id)}`,
  ])
  const membersAfterRemove = await psql(
    `SELECT count(*) FROM team_member WHERE team_id = '${teamId}'`,
  )
  const invitesAfterRemove = await psql(
    `SELECT count(*) FROM team_invite WHERE team_id = '${teamId}'`,
  )
  console.log(`team_member_count_after_remove=${membersAfterRemove}`)
  console.log(`team_invite_count_after_remove=${invitesAfterRemove}`)
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
  const membersAfter = await psql(
    `SELECT count(*) FROM team_member WHERE team_id = '${teamId}'`,
  )
  const invitesAfter = await psql(
    `SELECT count(*) FROM team_invite WHERE team_id = '${teamId}'`,
  )
  console.log(`invite_count_before=${before}`)
  console.log(`invite_count_after=${after}`)
  console.log(`team_member_count_after=${membersAfter}`)
  console.log(`team_invite_count_after=${invitesAfter}`)
  if (
    [
      lookup.status,
      create.status,
      remove.status,
      removeOther.status,
      deleted.status,
    ].some((status) => status !== '403')
  ) {
    throw new Error('member was not forbidden')
  }
  if (
    before !== after ||
    membersBefore !== membersAfterRemove ||
    invitesBefore !== invitesAfterRemove ||
    membersBefore !== membersAfter ||
    invitesBefore !== invitesAfter ||
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

  const fns = await loadServerFns()
  const saveFn = serverFn(fns, 'savePageFn')
  const fetchFn = serverFn(fns, 'fetchPage')
  const editor = await ownerCtx.newPage()
  step('former teammate inserts a live mention')
  await editor.goto(`${BASE_URL}/s/${team.spaceId}`, {
    waitUntil: 'networkidle',
  })
  await editor.getByRole('button', { name: '+ New page' }).first().click()
  await editor.locator('.doc-editor').waitFor()
  await editor.locator('.doc-editor').click()
  await editor.keyboard.type('@')
  await editor.getByRole('listbox', { name: 'Mention someone' }).waitFor()
  await editor.getByRole('option', { name: 'Ada West' }).waitFor()
  const mentionSaved = editor.waitForResponse(
    (response) =>
      response.url().includes(`/_serverFn/${saveFn.id}`) &&
      response.request().method() === 'POST',
    { timeout: 10000 },
  )
  await editor.getByRole('option', { name: 'Ada West' }).click()
  await editor.locator('.mention').first().waitFor()
  const mentionSave = await mentionSaved
  console.log(`mention_save_status=${mentionSave.status()}`)
  if (mentionSave.status() !== 200) throw new Error('mention did not save')
  const mentionedUrl = editor.url()
  console.log(`mentioned_path=${new URL(mentionedUrl).pathname}`)
  const mentionedPageId = new URL(mentionedUrl).pathname.split('/').pop() ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(mentionedPageId)) {
    throw new Error('mention page id was not a uuid')
  }
  await dump('owner removes mentioned teammate', [
    '-b',
    ownerJar,
    '-X',
    'DELETE',
    `${BASE_URL}/api/atlas/teams/${team.id}/members/${teammate.id}`,
  ])
  const loads: Array<Promise<{ status: number; body: string; path: string }>> =
    []
  editor.on('response', (response) => {
    if (!response.url().includes('/_serverFn/')) return
    const path = new URL(response.url()).pathname
    loads.push(
      response.text().then((body) => ({
        status: response.status(),
        body,
        path,
      })),
    )
  })
  const mentionedPath = new URL(mentionedUrl).pathname
  const documentLoad = editor.waitForResponse(
    (response) =>
      response.request().resourceType() === 'document' &&
      new URL(response.url()).pathname === mentionedPath,
  )
  step('reload the former-member mention')
  await editor.reload({ waitUntil: 'networkidle' })
  const documentResponse = await documentLoad
  const documentBody = await documentResponse.text()
  console.log(`page_load_status=${documentResponse.status()}`)
  console.log('page_load_begin')
  console.log(redact(documentBody))
  console.log('page_load_end')
  await editor.locator('.mention.former').waitFor()
  const fetched = await Promise.all(loads)
  const chip = editor.locator('.mention.former').first()
  const chipText = ((await chip.innerText()) ?? '').trim()
  const chipClass = (await chip.getAttribute('class')) ?? ''
  const editorHtml = await editor.locator('.doc').innerHTML()
  const pageHtml = await editor.content()
  console.log(`former_chip_text=${JSON.stringify(chipText)}`)
  console.log(`former_chip_class=${JSON.stringify(chipClass)}`)
  console.log('editor_html_begin')
  console.log(redact(editorHtml))
  console.log('editor_html_end')
  console.log('page_html_begin')
  console.log(redact(pageHtml))
  console.log('page_html_end')
  console.log(`serverfn_load_count=${fetched.length}`)
  fetched.forEach((item, index) => {
    console.log(`serverfn_load_${index}_status=${item.status}`)
    console.log(`serverfn_load_${index}_path=${item.path}`)
    console.log(`serverfn_load_${index}_begin`)
    console.log(redact(item.body))
    console.log(`serverfn_load_${index}_end`)
  })
  const ownerRead = await callServerFn(
    'former teammate server-function read',
    ownerJar,
    dir,
    'fetch-owner.json',
    fetchFn,
    { pageId: mentionedPageId },
  )
  console.log('grep former member email')
  const emailEditor = grepReport(
    'former_email_editor_html',
    editorHtml,
    teammate.email,
  )
  const emailPage = grepReport(
    'former_email_page_html',
    pageHtml,
    teammate.email,
  )
  const emailFetch = grepReport(
    'former_email_fetchpage',
    ownerRead.body,
    teammate.email,
  )
  const emailDocument = grepReport(
    'former_email_page_load',
    documentBody,
    teammate.email,
  )
  const emailServerFns = grepReport(
    'former_email_serverfn_loads',
    fetched.map((item) => item.body).join('\n'),
    teammate.email,
  )
  console.log('grep @')
  const atEditor = grepReport('at_editor_html', editorHtml, '@')
  grepReport('at_fetchpage', ownerRead.body, '@')
  grepReport('at_page_load', documentBody, '@')
  grepReport('at_page_html', pageHtml, '@')
  const outsiderPage = await outsiderCtx.newPage()
  step('outsider opens the mentioned page')
  const outsiderNav = await outsiderPage.goto(mentionedUrl, {
    waitUntil: 'networkidle',
  })
  console.log(`outsider_page_status=${outsiderNav?.status() ?? ''}`)
  const outsiderHtml = await outsiderPage.content()
  console.log('outsider_page_html_begin')
  console.log(redact(outsiderHtml))
  console.log('outsider_page_html_end')
  const emailOutsider = grepReport(
    'former_email_outsider_html',
    outsiderHtml,
    teammate.email,
  )
  grepReport('at_outsider_html', outsiderHtml, '@')
  const missingRead = await callServerFn(
    'missing page server-function read',
    outsiderJar,
    dir,
    'fetch-missing.json',
    fetchFn,
    { pageId: 'missing-page' },
  )
  const outsiderRead = await callServerFn(
    'outsider server-function read',
    outsiderJar,
    dir,
    'fetch-outsider.json',
    fetchFn,
    { pageId: mentionedPageId },
  )
  expectSame404('outsider_fetchPage', missingRead, outsiderRead)
  if (chipText !== 'Former member' || chipClass !== 'mention former') {
    throw new Error(`former chip rendered ${chipClass} ${chipText}`)
  }
  if (chipText.includes('Ada')) {
    throw new Error('former chip included the member name')
  }
  if (
    chipText.includes('@') ||
    chipText.includes(teammate.email) ||
    emailEditor !== 0 ||
    emailPage !== 0 ||
    emailFetch !== 0 ||
    emailDocument !== 0 ||
    emailServerFns !== 0 ||
    emailOutsider !== 0 ||
    atEditor !== 0
  ) {
    throw new Error('former member email leaked into the chip or page load')
  }
  if (documentResponse.status() !== 200 || ownerRead.status !== '200') {
    throw new Error('former teammate page load was not 200')
  }
  if ((outsiderNav?.status() ?? 0) !== 404) {
    throw new Error('outsider mention page was not 404')
  }
  await browser.close()
  await runNamedMentionTests()
}

async function runNamedMentionTests() {
  step('vitest chip and mention list')
  try {
    const result = await execFileAsync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        'tests/teams.test.ts',
        '-t',
        'scopes mentions',
        '--reporter=verbose',
      ],
      { env: process.env, maxBuffer: 10 * 1024 * 1024 },
    )
    process.stdout.write(result.stdout)
    process.stdout.write(result.stderr)
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    if (failed.stdout) process.stdout.write(failed.stdout)
    if (failed.stderr) process.stdout.write(failed.stderr)
    throw new Error('named mention tests failed')
  }
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
