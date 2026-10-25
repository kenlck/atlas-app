import { readFileSync } from 'node:fs'
import { closeDb, getSql } from '../src/lib/db'
import { archivePage, createPage, savePage } from '../src/lib/pages'
import { searchVisiblePages } from '../src/lib/search'
import { acceptInvite, createInvite, createTeam } from '../src/lib/teams'
import { createUser } from '../tests/helpers.ts'
import { assertLocalBaseUrl, assertLocalDatabaseUrl } from './verify-local.ts'

const PASSWORD = 'search-recipe-pass'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function redact(text: string) {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
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
  process.env.DATABASE_URL = url
  return url
}

function requireAuthEnv() {
  if (!process.env.BETTER_AUTH_SECRET) fail('BETTER_AUTH_SECRET is required')
  if (!process.env.BETTER_AUTH_URL) fail('BETTER_AUTH_URL is required')
}

function paragraph(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

let failed = false

function line(name: string, value: boolean, want: boolean) {
  console.log(`${name}=${value}`)
  if (value !== want) failed = true
}

function check(name: string, ok: boolean) {
  line(name, ok, true)
}

async function recipeVisibility() {
  const ada = await createUser('Ada Search')
  const bea = await createUser('Bea Search')
  const alpha = await createTeam(ada.user.id, 'Alpha Search')
  const beta = await createTeam(bea.user.id, 'Beta Search')
  const token = `vis-${crypto.randomUUID().slice(0, 8)}`
  const teamPage = await createPage(ada.user.id, {
    spaceId: alpha.spaceId,
    title: `${token}-team`,
  })
  const otherTeam = await createPage(bea.user.id, {
    spaceId: beta.spaceId,
    title: `${token}-other-team`,
  })
  const personal = await createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: `${token}-personal`,
  })
  const archived = await createPage(ada.user.id, {
    spaceId: ada.space.id,
    title: `${token}-archived`,
  })
  const child = await createPage(ada.user.id, {
    spaceId: ada.space.id,
    parentId: archived.id,
    title: `${token}-child`,
  })
  await archivePage(ada.user.id, archived.id)

  const beaHits = await searchVisiblePages(bea.user.id, token)
  const beaIds = beaHits.map((hit) => hit.id)
  line('cross_team_visible', beaIds.includes(teamPage.id), false)
  line('other_personal_visible', beaIds.includes(personal.id), false)
  line('caller_team_visible', beaIds.includes(otherTeam.id), true)

  const adaHits = await searchVisiblePages(ada.user.id, token)
  const adaIds = adaHits.map((hit) => hit.id)
  line('own_team_visible', adaIds.includes(teamPage.id), true)
  line('own_personal_visible', adaIds.includes(personal.id), true)
  line('archived_visible', adaIds.includes(archived.id), false)
  line('archived_child_visible', adaIds.includes(child.id), false)
  const leaked = [...adaHits, ...beaHits].some((hit) => {
    if (hit.id === teamPage.id || hit.id === otherTeam.id) return false
    return (
      hit.snippet.includes(`${token}-team`) ||
      hit.title.includes(`${token}-team`)
    )
  })
  line('snippet_leaks_hidden', leaked, false)
}

async function recipeWildcards() {
  const owner = await createUser('Wildcard')
  const stamp = crypto.randomUUID().slice(0, 8)
  const percent = await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: `${stamp} 100%`,
  })
  await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: `${stamp} 100x`,
  })
  const underscore = await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: `${stamp} a_b`,
  })
  await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: `${stamp} axb`,
  })
  const slash = await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: `${stamp} a\\b`,
  })
  await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: `${stamp} ab`,
  })

  const percentHits = await searchVisiblePages(owner.user.id, `${stamp} 100%`)
  check(
    'percent_literal',
    percentHits.length === 1 && percentHits[0]?.id === percent.id,
  )
  const underscoreHits = await searchVisiblePages(owner.user.id, `${stamp} a_b`)
  check(
    'underscore_literal',
    underscoreHits.length === 1 && underscoreHits[0]?.id === underscore.id,
  )
  const slashHits = await searchVisiblePages(owner.user.id, `${stamp} a\\b`)
  check(
    'backslash_literal',
    slashHits.length === 1 && slashHits[0]?.id === slash.id,
  )
}

async function recipeBody() {
  const owner = await createUser('Body Only')
  const token = `body-${crypto.randomUUID().slice(0, 8)}`
  const created = await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Quarter notes',
  })
  await savePage(owner.user.id, {
    pageId: created.id,
    title: 'Quarter notes',
    body: paragraph(token),
  })
  const hits = await searchVisiblePages(owner.user.id, token)
  check(
    'body_only_visible',
    hits.length === 1 &&
      hits[0]?.id === created.id &&
      hits[0]?.group === 'content',
  )
}

async function recipeAutosave() {
  const owner = await createUser('Autosave')
  const token = `saved-${crypto.randomUUID().slice(0, 8)}`
  const created = await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Scratch',
  })
  await savePage(owner.user.id, {
    pageId: created.id,
    title: 'Scratch',
    body: paragraph(token),
  })
  const hits = await searchVisiblePages(owner.user.id, token)
  check(
    'autosave_visible',
    hits.some((hit) => hit.id === created.id),
  )
}

async function recipeBackfill() {
  const migration = readFileSync('drizzle/0003_page_text.sql', 'utf8')
  check(
    'migration_updates_body_text',
    migration.includes('UPDATE page SET body_text = page_plain_text(body)'),
  )
  const owner = await createUser('Backfill')
  const created = await createPage(owner.user.id, {
    spaceId: owner.space.id,
    title: 'Old page',
  })
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'backfill-token' },
          {
            type: 'mention',
            attrs: { id: 'person', label: 'Backfill Person' },
          },
          { type: 'dateChip', attrs: { date: '2026-03-04' } },
        ],
      },
    ],
  }
  await getSql()`
    update page
    set body = ${JSON.stringify(doc)}::jsonb, body_text = ''
    where id = ${created.id}
  `
  await getSql()`
    update page set body_text = page_plain_text(body) where id = ${created.id}
  `
  const rows =
    await getSql()`select body_text from page where id = ${created.id}`
  const text = String(rows[0]?.body_text ?? '')
  check(
    'backfill_body_text',
    text.includes('backfill-token') &&
      text.includes('Backfill Person') &&
      text.includes('Mar 4, 2026'),
  )
}

async function recipeLabels() {
  const owner = await createUser('Owner Label')
  const member = await createUser('Nia Quill')
  const team = await createTeam(owner.user.id, 'Label Team')
  const invite = await createInvite(owner.user.id, team.id, member.user.id)
  await acceptInvite(member.user.id, invite.id)
  const created = await createPage(owner.user.id, {
    spaceId: team.spaceId,
    title: 'Labels',
  })
  await savePage(owner.user.id, {
    pageId: created.id,
    title: 'Labels',
    body: {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'widget-cell' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: { id: member.user.id, label: 'Nia Quill' },
            },
            { type: 'text', text: ' ' },
            { type: 'dateChip', attrs: { date: '2024-08-19' } },
          ],
        },
      ],
    },
  })
  const tableHits = await searchVisiblePages(owner.user.id, 'widget-cell')
  const mentionHits = await searchVisiblePages(owner.user.id, 'Nia Quill')
  const dateHits = await searchVisiblePages(owner.user.id, 'Aug 19, 2024')
  check(
    'table_label_visible',
    tableHits.some((hit) => hit.id === created.id),
  )
  check(
    'mention_label_visible',
    mentionHits.some((hit) => hit.id === created.id),
  )
  check(
    'date_label_visible',
    dateHits.some((hit) => hit.id === created.id),
  )
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

async function signUp(base: string) {
  const email = `search.${crypto.randomUUID()}@example.com`
  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        name: 'Search Safe',
        email,
        password: PASSWORD,
      }),
    })
    if (response.status !== 429) break
    console.log('signup_status=429')
    await response.text().catch(() => '')
    await new Promise((resolve) => setTimeout(resolve, 11_000))
  }
  if (!response) fail('sign-up missing response')
  await response.text()
  console.log(`signup_status=${response.status}`)
  if (response.status !== 200) fail('sign-up failed')
  const cookie = cookieHeader(response)
  if (!cookie) fail('signup_cookie=missing')
  return cookie
}

async function recipeSafe() {
  if (!process.env.BASE_URL) fail('BASE_URL is required')
  const base = assertLocalBaseUrl(process.env.BASE_URL)
  const cookie = await signUp(base)
  const queries: Array<[string, string]> = [
    ['safe_amp', 'a&b'],
    ['safe_paren', '('],
    ['safe_prefix_syntax', 'plan:*'],
    ['safe_quote', "'"],
    ['safe_backslash', '\\'],
    ['safe_emoji', '😀'],
    ['safe_empty', ''],
    ['safe_one', 'a'],
  ]
  for (const [name, query] of queries) {
    const response = await fetch(
      `${base}/api/atlas/search?q=${encodeURIComponent(query)}`,
      { headers: { cookie, origin: base } },
    )
    const text = await response.text()
    let hits = false
    if (response.status === 200) {
      try {
        const body = JSON.parse(text) as { hits?: unknown }
        hits = Array.isArray(body.hits)
      } catch {
        hits = false
      }
    }
    console.log(`${name}=${response.status}`)
    if (response.status !== 200 || !hits) failed = true
  }
}

const recipes: Record<string, () => Promise<void>> = {
  '4-1': recipeVisibility,
  '4-2': recipeWildcards,
  '4-3': recipeBody,
  '4-4': recipeAutosave,
  '4-5': recipeBackfill,
  '4-6': recipeLabels,
  '4-7': recipeSafe,
}

const name = process.argv[2] ?? ''
const recipe = recipes[name]
if (!recipe) fail('usage: search-fail.ts 4-1|4-2|4-3|4-4|4-5|4-6|4-7')

databaseUrl()
requireAuthEnv()

recipe()
  .then(async () => {
    await closeDb()
    if (failed) process.exit(1)
  })
  .catch(async (error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'search recipe failed'
    console.error(redact(message))
    await closeDb().catch(() => {})
    process.exit(1)
  })
