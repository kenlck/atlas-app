import postgres from 'postgres'
import { clockInZone, zonedDateTimeToUtc } from '../src/lib/calendar-time'
import { postgresPoolOptions } from '../src/lib/postgres-options'
import { assertLocalBaseUrl, assertLocalDatabaseUrl } from './verify-local.ts'

const PASSWORD = 'calendar-recipe-pass'
const KICKOFF_START = '2026-06-15T15:00:00-10:00'
const KICKOFF_UTC = '2026-06-16T01:00:00.000Z'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function databaseUrl() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  if (!url) fail('DATABASE_URL or TEST_DATABASE_URL is required')
  try {
    assertLocalDatabaseUrl(url)
  } catch {
    console.error('refusing non-local DATABASE_URL')
    process.exit(2)
  }
  return url
}

function baseUrl() {
  if (!process.env.BASE_URL) fail('BASE_URL is required')
  return assertLocalBaseUrl(process.env.BASE_URL)
}

function redact(text: string) {
  return text
    .replace(
      /better-auth\.session_token=[^;\s]+/g,
      'better-auth.session_token=[redacted]',
    )
    .replace(/("token"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/("password"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
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
  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name, email, password: PASSWORD }),
    })
    if (response.status !== 429) break
    // Sign-up shares a 3-per-10s bucket with sign-in. Wait out that window.
    const retryAfter = Number(response.headers.get('x-retry-after') ?? '10')
    const seconds = Math.min(
      15,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter + 1 : 11,
    )
    console.log(`signup_status=429 retry_after=${seconds}`)
    await response.text().catch(() => '')
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }
  if (!response) fail('sign-up missing response')
  const text = await response.text()
  console.log(`signup_status=${response.status}`)
  if (response.status !== 200) fail(redact(text).slice(0, 240))
  const cookie = cookieHeader(response)
  if (!cookie) fail('signup_cookie=missing')
  const body = JSON.parse(text) as { user?: { id?: string } }
  if (!body.user?.id) fail('signup_user=missing')
  return { cookie, id: body.user.id, email }
}

async function api(
  base: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: base,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

async function createTeam(base: string, cookie: string, name: string) {
  const response = await api(base, cookie, 'POST', '/api/atlas/teams', { name })
  if (response.status !== 201) fail(`create_team_status=${response.status}`)
  const body = JSON.parse(response.text) as { id?: string; spaceId?: string }
  if (!body.id || !body.spaceId) fail('create_team=missing')
  return { id: body.id, spaceId: body.spaceId }
}

function calendarPath(teamId: string, month: string, timeZone: string) {
  const params = new URLSearchParams({ month, timeZone })
  return `/api/atlas/teams/${teamId}/calendar?${params}`
}

const kickoff = {
  title: 'Kickoff',
  allDay: false,
  startAt: KICKOFF_START,
  endAt: '2026-06-15T16:00:00-10:00',
}

async function recipe51(base: string, sql: postgres.Sql) {
  const ada = await signUp(base, 'Ada')
  const bea = await signUp(base, 'Bea')
  const teamA = await createTeam(base, ada.cookie, 'Team A')
  const teamB = await createTeam(base, bea.cookie, 'Team B')
  const created = await api(
    base,
    ada.cookie,
    'POST',
    `/api/atlas/teams/${teamA.id}/calendar/events`,
    kickoff,
  )
  console.log(`member_create_status=${created.status}`)
  if (created.status !== 201) fail('member create failed')
  const event = JSON.parse(created.text) as { id?: string }
  if (!event.id) fail('member create missing id')

  const list = await api(
    base,
    bea.cookie,
    'GET',
    calendarPath(teamA.id, '2026-06', 'UTC'),
  )
  const create = await api(
    base,
    bea.cookie,
    'POST',
    `/api/atlas/teams/${teamA.id}/calendar/events`,
    kickoff,
  )
  const update = await api(
    base,
    bea.cookie,
    'POST',
    `/api/atlas/teams/${teamA.id}/calendar/events/${event.id}`,
    {
      ...kickoff,
      title: 'Changed',
    },
  )
  const remove = await api(
    base,
    bea.cookie,
    'DELETE',
    `/api/atlas/teams/${teamA.id}/calendar/events/${event.id}`,
  )
  const invalid = await api(
    base,
    bea.cookie,
    'POST',
    `/api/atlas/teams/${teamA.id}/calendar/events`,
    {
      title: 'Backwards',
      allDay: false,
      startAt: '2026-06-15T16:00:00Z',
      endAt: '2026-06-15T15:00:00Z',
    },
  )
  const missing = await api(
    base,
    ada.cookie,
    'GET',
    calendarPath('missing-team', '2026-06', 'UTC'),
  )
  const spaces = await sql<{ id: string }[]>`
    select id from space where owner_user_id = ${ada.id} and kind = 'personal' limit 1
  `
  const personalId = spaces[0]?.id
  if (!personalId) fail('personal_space=missing')
  const personal = await api(
    base,
    ada.cookie,
    'GET',
    calendarPath(personalId, '2026-06', 'UTC'),
  )
  const other = await api(
    base,
    bea.cookie,
    'GET',
    calendarPath(teamB.id, '2026-06', 'UTC'),
  )
  const visible = other.status === 200 && other.text.includes(event.id)

  console.log(`non_member_calendar_status=${list.status}`)
  console.log(`non_member_create_status=${create.status}`)
  console.log(`non_member_update_status=${update.status}`)
  console.log(`non_member_delete_status=${remove.status}`)
  console.log(`non_member_invalid_status=${invalid.status}`)
  console.log(`missing_team_status=${missing.status}`)
  console.log(`personal_calendar_status=${personal.status}`)
  console.log(`other_team_event_visible=${visible}`)

  const statuses = [
    list,
    create,
    update,
    remove,
    invalid,
    missing,
    personal,
  ].map((item) => item.status)
  if (
    statuses.some((status) => status !== 404) ||
    visible ||
    created.status !== 201
  ) {
    fail('recipe 5-1 failed')
  }
}

async function recipe52(base: string, sql: postgres.Sql) {
  const ada = await signUp(base, 'Ada')
  const team = await createTeam(base, ada.cookie, 'Range')
  const beforeRows = await sql<
    { n: number }[]
  >`select count(*)::int as n from calendar_event`
  const before = beforeRows[0]?.n ?? 0
  const timed = await api(
    base,
    ada.cookie,
    'POST',
    `/api/atlas/teams/${team.id}/calendar/events`,
    {
      title: 'Backwards',
      allDay: false,
      startAt: '2026-06-15T16:00:00Z',
      endAt: '2026-06-15T15:00:00Z',
    },
  )
  const allDay = await api(
    base,
    ada.cookie,
    'POST',
    `/api/atlas/teams/${team.id}/calendar/events`,
    {
      title: 'Backwards day',
      allDay: true,
      startDate: '2026-06-03',
      endDate: '2026-06-01',
    },
  )
  const afterRows = await sql<
    { n: number }[]
  >`select count(*)::int as n from calendar_event`
  const after = afterRows[0]?.n ?? 0
  const wrote = before !== after
  console.log(`invalid_range_status=${timed.status}`)
  console.log(`invalid_all_day_status=${allDay.status}`)
  console.log(`rows_before=${before}`)
  console.log(`rows_after=${after}`)
  console.log(`wrote_invalid=${wrote}`)
  if (timed.status !== 400 || allDay.status !== 400 || wrote)
    fail('recipe 5-2 failed')
}

async function invite(
  base: string,
  ownerCookie: string,
  teamId: string,
  email: string,
  memberCookie: string,
) {
  const lookup = await api(
    base,
    ownerCookie,
    'POST',
    `/api/atlas/teams/${teamId}/invites/lookup`,
    { email },
  )
  if (lookup.status !== 200) fail(`lookup_status=${lookup.status}`)
  const found = JSON.parse(lookup.text) as { user?: { id?: string } }
  if (!found.user?.id) fail('lookup_user=missing')
  const created = await api(
    base,
    ownerCookie,
    'POST',
    `/api/atlas/teams/${teamId}/invites`,
    {
      userId: found.user.id,
    },
  )
  if (created.status !== 201) fail(`invite_status=${created.status}`)
  const inviteBody = JSON.parse(created.text) as { id?: string }
  if (!inviteBody.id) fail('invite_id=missing')
  const accepted = await api(
    base,
    memberCookie,
    'POST',
    `/api/atlas/invites/${inviteBody.id}/accept`,
  )
  if (accepted.status !== 200) fail(`accept_status=${accepted.status}`)
}

async function recipe53(base: string, sql: postgres.Sql) {
  const ada = await signUp(base, 'Ada')
  const bea = await signUp(base, 'Bea')
  const team = await createTeam(base, ada.cookie, 'Zones')
  await invite(base, ada.cookie, team.id, bea.email, bea.cookie)
  const timed = await api(
    base,
    ada.cookie,
    'POST',
    `/api/atlas/teams/${team.id}/calendar/events`,
    kickoff,
  )
  const day = await api(
    base,
    ada.cookie,
    'POST',
    `/api/atlas/teams/${team.id}/calendar/events`,
    {
      title: 'Holiday',
      allDay: true,
      startDate: '2026-06-15',
      endDate: '2026-06-15',
    },
  )
  console.log(`timed_create_status=${timed.status}`)
  console.log(`all_day_create_status=${day.status}`)
  if (timed.status !== 201 || day.status !== 201)
    fail('recipe 5-3 create failed')
  const timedBody = JSON.parse(timed.text) as { id?: string; startAt?: string }
  const dayBody = JSON.parse(day.text) as {
    id?: string
    startDate?: string
    endDate?: string
  }
  if (!timedBody.id || !dayBody.id) fail('recipe 5-3 ids missing')

  const adaList = await api(
    base,
    ada.cookie,
    'GET',
    calendarPath(team.id, '2026-06', 'Pacific/Kiritimati'),
  )
  const beaList = await api(
    base,
    bea.cookie,
    'GET',
    calendarPath(team.id, '2026-06', 'Pacific/Midway'),
  )
  console.log(`member_a_status=${adaList.status}`)
  console.log(`member_b_status=${beaList.status}`)
  if (adaList.status !== 200 || beaList.status !== 200)
    fail('recipe 5-3 list failed')
  const adaEvents = JSON.parse(adaList.text) as {
    events: Array<{
      id: string
      startAt: string | null
      startDate: string | null
      endDate: string | null
    }>
  }
  const beaEvents = JSON.parse(beaList.text) as {
    events: Array<{
      id: string
      startAt: string | null
      startDate: string | null
      endDate: string | null
    }>
  }
  const adaTimed = adaEvents.events.find((item) => item.id === timedBody.id)
  const beaTimed = beaEvents.events.find((item) => item.id === timedBody.id)
  const adaDay = adaEvents.events.find((item) => item.id === dayBody.id)
  const beaDay = beaEvents.events.find((item) => item.id === dayBody.id)
  if (!adaTimed?.startAt || adaTimed.startAt !== beaTimed?.startAt)
    fail('members saw different instants')
  console.log(`stored_start=${adaTimed.startAt}`)
  const kiritimati = clockInZone(adaTimed.startAt, 'Pacific/Kiritimati')
  const midway = clockInZone(adaTimed.startAt, 'Pacific/Midway')
  console.log(`kiritimati=${kiritimati.date} ${kiritimati.clock}`)
  console.log(`midway=${midway.date} ${midway.clock}`)
  const backEast = zonedDateTimeToUtc(
    kiritimati.parts.year,
    kiritimati.parts.month,
    kiritimati.parts.day,
    kiritimati.parts.hour,
    kiritimati.parts.minute,
    0,
    'Pacific/Kiritimati',
  ).toISOString()
  const backWest = zonedDateTimeToUtc(
    midway.parts.year,
    midway.parts.month,
    midway.parts.day,
    midway.parts.hour,
    midway.parts.minute,
    0,
    'Pacific/Midway',
  ).toISOString()
  const same =
    backEast === adaTimed.startAt &&
    backWest === adaTimed.startAt &&
    adaTimed.startAt === KICKOFF_UTC
  console.log(`same_instant=${same}`)

  const dayId = dayBody.id
  const reserved = await sql.reserve()
  let dates: { east: string | undefined; west: string | undefined }
  try {
    await reserved.unsafe(`set time zone 'Pacific/Kiritimati'`)
    const east = await reserved<Array<{ start_date: string }>>`
      select start_date::text as start_date from calendar_event where id = ${dayId}
    `
    await reserved.unsafe(`set time zone 'Pacific/Midway'`)
    const west = await reserved<Array<{ start_date: string }>>`
      select start_date::text as start_date from calendar_event where id = ${dayId}
    `
    dates = { east: east[0]?.start_date, west: west[0]?.start_date }
  } finally {
    reserved.release()
  }
  const shifted =
    adaDay?.startDate !== '2026-06-15' ||
    adaDay.endDate !== '2026-06-15' ||
    beaDay?.startDate !== '2026-06-15' ||
    beaDay.endDate !== '2026-06-15' ||
    dates.east !== '2026-06-15' ||
    dates.west !== '2026-06-15'
  console.log(`all_day_start=${adaDay?.startDate ?? ''}`)
  console.log(`all_day_shifted=${shifted}`)

  const columns = await sql<{ column_name: string; data_type: string }[]>`
    select column_name, data_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'calendar_event'
  `
  const typeOf = (name: string) =>
    columns.find((column) => column.column_name === name)?.data_type ?? ''
  console.log(`start_at_type=${typeOf('start_at')}`)
  console.log(`start_date_type=${typeOf('start_date')}`)
  if (
    !same ||
    shifted ||
    typeOf('start_at') !== 'timestamp with time zone' ||
    typeOf('start_date') !== 'date'
  ) {
    fail('recipe 5-3 failed')
  }
}

async function recipe54(base: string) {
  const ada = await signUp(base, 'Ada')
  const team = await createTeam(base, ada.cookie, 'Span')
  const days = await api(
    base,
    ada.cookie,
    'POST',
    `/api/atlas/teams/${team.id}/calendar/events`,
    {
      title: 'Site visit',
      allDay: true,
      startDate: '2026-01-30',
      endDate: '2026-02-02',
    },
  )
  const hours = await api(
    base,
    ada.cookie,
    'POST',
    `/api/atlas/teams/${team.id}/calendar/events`,
    {
      title: 'Handoff',
      allDay: false,
      startAt: '2026-02-01T07:30:00Z',
      endAt: '2026-02-01T09:30:00Z',
    },
  )
  if (days.status !== 201 || hours.status !== 201)
    fail('recipe 5-4 create failed')
  const dayId = (JSON.parse(days.text) as { id?: string }).id
  const hourId = (JSON.parse(hours.text) as { id?: string }).id
  if (!dayId || !hourId) fail('recipe 5-4 ids missing')
  const january = await api(
    base,
    ada.cookie,
    'GET',
    calendarPath(team.id, '2026-01', 'America/Los_Angeles'),
  )
  const february = await api(
    base,
    ada.cookie,
    'GET',
    calendarPath(team.id, '2026-02', 'America/Los_Angeles'),
  )
  const januaryContains =
    january.text.includes(dayId) && january.text.includes(hourId)
  const februaryContains =
    february.text.includes(dayId) && february.text.includes(hourId)
  console.log(`january_status=${january.status}`)
  console.log(`february_status=${february.status}`)
  console.log(`january_contains=${januaryContains}`)
  console.log(`february_contains=${februaryContains}`)
  if (
    january.status !== 200 ||
    february.status !== 200 ||
    !januaryContains ||
    !februaryContains
  ) {
    fail('recipe 5-4 failed')
  }
}

const recipe = process.argv[2]
const base = baseUrl()
const url = databaseUrl()
const sql = postgres(url, { ...postgresPoolOptions(url), max: 1 })

try {
  if (recipe === '5-1') await recipe51(base, sql)
  else if (recipe === '5-2') await recipe52(base, sql)
  else if (recipe === '5-3') await recipe53(base, sql)
  else if (recipe === '5-4') await recipe54(base)
  else fail('usage: calendar-fail.ts [5-1|5-2|5-3|5-4]')
} catch (error) {
  const text = error instanceof Error ? error.message : 'calendar-fail failed'
  console.error(redact(text).slice(0, 300))
  process.exit(1)
} finally {
  await sql.end({ timeout: 5 })
}
