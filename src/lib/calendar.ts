import { and, eq, gte, lt, lte, or, sql } from 'drizzle-orm'
import { assertAccess } from './access'
import {
  firstDateOfMonth,
  isCivilDate,
  isTimeZone,
  lastDateOfMonth,
  monthBounds,
  parseInstant,
  parseMonth,
  type CalendarEventJson,
} from './calendar-time'
import { getDb } from './db'
import { HttpError, notFound } from './http'
import { newId } from './ids'
import { calendarEvent } from './schema'
import { assertTeamAccess } from './teams'

const TITLE_MAX = 200
const NOTE_MAX = 4000

type StoredEvent = {
  title: string
  allDay: boolean
  startAt: Date | null
  endAt: Date | null
  startDate: string | null
  endDate: string | null
  note: string | null
}

function badRequest(): never {
  throw new HttpError(400, 'Bad request')
}

function plainDate(value: unknown) {
  if (typeof value !== 'string') return null
  const date = value.slice(0, 10)
  return isCivilDate(date) ? date : null
}

// Timed values are UTC instants. All-day values are civil dates with no zone.
function readStored(body: Record<string, unknown>): StoredEvent {
  if (typeof body.title !== 'string') badRequest()
  const title = body.title.trim()
  if (!title) throw new HttpError(400, 'Title is required')
  if (title.length > TITLE_MAX) throw new HttpError(400, 'Title is too long')
  if (typeof body.allDay !== 'boolean') badRequest()
  let note: string | null = null
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') badRequest()
    const trimmed = body.note.trim()
    if (trimmed.length > NOTE_MAX) throw new HttpError(400, 'Note is too long')
    note = trimmed || null
  }
  if (body.allDay) {
    if (body.startAt != null || body.endAt != null) badRequest()
    const startDate = plainDate(body.startDate)
    const endDate = plainDate(body.endDate)
    if (!startDate || !endDate) badRequest()
    if (endDate < startDate) {
      throw new HttpError(400, 'Event ends before it starts')
    }
    return {
      title,
      allDay: true,
      startAt: null,
      endAt: null,
      startDate,
      endDate,
      note,
    }
  }
  if (body.startDate != null || body.endDate != null) badRequest()
  if (typeof body.startAt !== 'string' || typeof body.endAt !== 'string') {
    badRequest()
  }
  const startAt = parseInstant(body.startAt)
  const endAt = parseInstant(body.endAt)
  if (!startAt || !endAt) badRequest()
  if (endAt.getTime() < startAt.getTime()) {
    throw new HttpError(400, 'Event ends before it starts')
  }
  return {
    title,
    allDay: false,
    startAt,
    endAt,
    startDate: null,
    endDate: null,
    note,
  }
}

function toJson(row: {
  id: string
  title: string
  allDay: boolean
  startAt: Date | null
  endAt: Date | null
  startDate: string | null
  endDate: string | null
  note: string | null
}): CalendarEventJson {
  return {
    id: row.id,
    title: row.title,
    allDay: row.allDay,
    startAt: row.startAt ? row.startAt.toISOString() : null,
    endAt: row.endAt ? row.endAt.toISOString() : null,
    startDate: row.startDate ? row.startDate.slice(0, 10) : null,
    endDate: row.endDate ? row.endDate.slice(0, 10) : null,
    note: row.note,
  }
}

const eventColumns = {
  id: calendarEvent.id,
  title: calendarEvent.title,
  allDay: calendarEvent.allDay,
  startAt: calendarEvent.startAt,
  endAt: calendarEvent.endAt,
  startDate: sql<string | null>`${calendarEvent.startDate}::text`,
  endDate: sql<string | null>`${calendarEvent.endDate}::text`,
  note: calendarEvent.note,
}

export async function openCalendar(userId: string, spaceId: string) {
  const access = await assertAccess(userId, { spaceId })
  if (access.role === 'personal' || !access.space.teamId) notFound()
  return { teamId: access.space.teamId, spaceId: access.space.id }
}

export async function listEvents(
  userId: string,
  teamId: string,
  month: string,
  timeZone: string,
) {
  await assertTeamAccess(userId, teamId)
  const parsed = parseMonth(month)
  if (!parsed || !isTimeZone(timeZone)) badRequest()
  const { start, end } = monthBounds(parsed.year, parsed.month, timeZone)
  const first = firstDateOfMonth(parsed.year, parsed.month)
  const last = lastDateOfMonth(parsed.year, parsed.month)
  const db = getDb()
  const rows = await db
    .select(eventColumns)
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.teamId, teamId),
        or(
          and(
            eq(calendarEvent.allDay, false),
            lt(calendarEvent.startAt, end),
            gte(calendarEvent.endAt, start),
          ),
          and(
            eq(calendarEvent.allDay, true),
            lte(calendarEvent.startDate, last),
            gte(calendarEvent.endDate, first),
          ),
        ),
      ),
    )
  return rows.map(toJson).sort((a, b) => {
    const aKey = a.allDay ? `${a.startDate}T00:00:00.000Z` : (a.startAt ?? '')
    const bKey = b.allDay ? `${b.startDate}T00:00:00.000Z` : (b.startAt ?? '')
    return aKey.localeCompare(bKey) || a.title.localeCompare(b.title)
  })
}

export async function createEvent(
  userId: string,
  teamId: string,
  body: Record<string, unknown>,
) {
  await assertTeamAccess(userId, teamId)
  const stored = readStored(body)
  const db = getDb()
  const id = newId()
  const now = new Date()
  await db.insert(calendarEvent).values({
    id,
    teamId,
    title: stored.title,
    allDay: stored.allDay,
    startAt: stored.startAt,
    endAt: stored.endAt,
    startDate: stored.startDate,
    endDate: stored.endDate,
    note: stored.note,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
  })
  return readEvent(teamId, id)
}

export async function updateEvent(
  userId: string,
  teamId: string,
  eventId: string,
  body: Record<string, unknown>,
) {
  await assertTeamAccess(userId, teamId)
  const stored = readStored(body)
  const db = getDb()
  const existing = await db
    .select({ id: calendarEvent.id })
    .from(calendarEvent)
    .where(and(eq(calendarEvent.id, eventId), eq(calendarEvent.teamId, teamId)))
    .limit(1)
  if (!existing[0]) notFound()
  await db
    .update(calendarEvent)
    .set({
      title: stored.title,
      allDay: stored.allDay,
      startAt: stored.startAt,
      endAt: stored.endAt,
      startDate: stored.startDate,
      endDate: stored.endDate,
      note: stored.note,
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .where(and(eq(calendarEvent.id, eventId), eq(calendarEvent.teamId, teamId)))
  return readEvent(teamId, eventId)
}

export async function deleteEvent(
  userId: string,
  teamId: string,
  eventId: string,
) {
  await assertTeamAccess(userId, teamId)
  const db = getDb()
  const existing = await db
    .select({ id: calendarEvent.id })
    .from(calendarEvent)
    .where(and(eq(calendarEvent.id, eventId), eq(calendarEvent.teamId, teamId)))
    .limit(1)
  if (!existing[0]) notFound()
  await db
    .delete(calendarEvent)
    .where(and(eq(calendarEvent.id, eventId), eq(calendarEvent.teamId, teamId)))
  return { ok: true as const }
}

async function readEvent(teamId: string, eventId: string) {
  const db = getDb()
  const rows = await db
    .select(eventColumns)
    .from(calendarEvent)
    .where(and(eq(calendarEvent.id, eventId), eq(calendarEvent.teamId, teamId)))
    .limit(1)
  if (!rows[0]) notFound()
  return toJson(rows[0])
}
