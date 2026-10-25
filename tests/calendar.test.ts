import { count } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { layoutBars } from '../src/lib/calendar-layout'
import {
  clockInZone,
  monthBounds,
  zonedDateTimeToUtc,
} from '../src/lib/calendar-time'
import {
  createEvent,
  deleteEvent,
  listEvents,
  openCalendar,
  updateEvent,
} from '../src/lib/calendar'
import { getDb, getSql } from '../src/lib/db'
import { HttpError } from '../src/lib/http'
import { calendarEvent } from '../src/lib/schema'
import { acceptInvite, createInvite, createTeam } from '../src/lib/teams'
import { createUser } from './helpers'

const ZONE = 'America/Los_Angeles'

async function eventCount() {
  const [row] = await getDb().select({ n: count() }).from(calendarEvent)
  return row?.n ?? 0
}

async function teamWithMember() {
  const owner = await createUser('Owner')
  const member = await createUser('Member')
  const outsider = await createUser('Outsider')
  const created = await createTeam(owner.user.id, 'Field')
  const invite = await createInvite(owner.user.id, created.id, member.user.id)
  await acceptInvite(member.user.id, invite.id)
  return { owner, member, outsider, created }
}

describe('team calendar', () => {
  it('returns 404 for a non-member and keeps events on their own team', async () => {
    const { owner, member, outsider, created } = await teamWithMember()
    const other = await createTeam(outsider.user.id, 'Other')
    const event = await createEvent(member.user.id, created.id, {
      title: 'Standup',
      allDay: false,
      startAt: '2026-06-15T15:00:00Z',
      endAt: '2026-06-15T16:00:00Z',
    })

    const missing = await listEvents(
      owner.user.id,
      'missing-team',
      '2026-06',
      'UTC',
    ).then(
      () => null,
      (error: HttpError) => error,
    )
    const denied = await listEvents(
      outsider.user.id,
      created.id,
      '2026-06',
      'UTC',
    ).then(
      () => null,
      (error: HttpError) => error,
    )
    expect(denied?.status).toBe(404)
    expect(denied?.message).toBe('Not found')
    expect(denied?.status).toBe(missing?.status)
    expect(denied?.message).toBe(missing?.message)

    await expect(
      createEvent(outsider.user.id, created.id, {
        title: 'Nope',
        allDay: true,
        startDate: '2026-06-02',
        endDate: '2026-06-01',
      }),
    ).rejects.toMatchObject({ status: 404, message: 'Not found' })
    await expect(
      updateEvent(outsider.user.id, created.id, event.id, {
        title: 'Changed',
        allDay: false,
        startAt: '2026-06-15T15:00:00Z',
        endAt: '2026-06-15T16:00:00Z',
      }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      deleteEvent(outsider.user.id, created.id, event.id),
    ).rejects.toMatchObject({
      status: 404,
    })

    const own = await listEvents(member.user.id, created.id, '2026-06', 'UTC')
    const theirs = await listEvents(
      outsider.user.id,
      other.id,
      '2026-06',
      'UTC',
    )
    expect(own.map((item) => item.id)).toContain(event.id)
    expect(theirs.map((item) => item.id)).not.toContain(event.id)
    await expect(
      openCalendar(outsider.user.id, created.spaceId),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
    const opened = await openCalendar(member.user.id, created.spaceId)
    expect(opened.teamId).toBe(created.id)
  })

  it('returns 404 for a calendar in a personal space', async () => {
    const person = await createUser('Solo')
    await expect(
      openCalendar(person.user.id, person.space.id),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
  })

  it('rejects an event that ends before it starts and does not write', async () => {
    const { member, created } = await teamWithMember()
    const before = await eventCount()
    await expect(
      createEvent(member.user.id, created.id, {
        title: 'Backwards',
        allDay: false,
        startAt: '2026-06-15T16:00:00Z',
        endAt: '2026-06-15T15:00:00Z',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Event ends before it starts',
    })
    await expect(
      createEvent(member.user.id, created.id, {
        title: 'Backwards day',
        allDay: true,
        startDate: '2026-06-03',
        endDate: '2026-06-01',
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(await eventCount()).toBe(before)

    const saved = await createEvent(member.user.id, created.id, {
      title: 'Point',
      allDay: false,
      startAt: '2026-06-15T15:00:00Z',
      endAt: '2026-06-15T15:00:00Z',
    })
    expect(saved.startAt).toBe('2026-06-15T15:00:00.000Z')
  })

  it('keeps a timed instant and an all-day date across zones', async () => {
    const { owner, member, created } = await teamWithMember()
    const timed = await createEvent(owner.user.id, created.id, {
      title: 'Kickoff',
      allDay: false,
      startAt: '2026-06-15T15:00:00-10:00',
      endAt: '2026-06-15T16:00:00-10:00',
    })
    const day = await createEvent(owner.user.id, created.id, {
      title: 'Holiday',
      allDay: true,
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      note: 'Office closed',
    })
    expect(timed.startAt).toBe('2026-06-16T01:00:00.000Z')
    expect(timed.endAt).toBe('2026-06-16T02:00:00.000Z')
    expect(timed.startDate).toBeNull()
    expect(day.startDate).toBe('2026-06-15')
    expect(day.endDate).toBe('2026-06-15')
    expect(day.startAt).toBeNull()

    const forOwner = await listEvents(
      owner.user.id,
      created.id,
      '2026-06',
      'UTC',
    )
    const forMember = await listEvents(
      member.user.id,
      created.id,
      '2026-06',
      'Pacific/Kiritimati',
    )
    const ownerTimed = forOwner.find((item) => item.id === timed.id)
    const memberTimed = forMember.find((item) => item.id === timed.id)
    expect(ownerTimed?.startAt).toBe(memberTimed?.startAt)
    expect(ownerTimed?.startAt).toBe('2026-06-16T01:00:00.000Z')

    const kiritimati = clockInZone(
      ownerTimed?.startAt ?? '',
      'Pacific/Kiritimati',
    )
    const midway = clockInZone(ownerTimed?.startAt ?? '', 'Pacific/Midway')
    expect(`${kiritimati.date} ${kiritimati.clock}`).toBe('2026-06-16 15:00')
    expect(`${midway.date} ${midway.clock}`).toBe('2026-06-15 14:00')
    expect(
      zonedDateTimeToUtc(
        kiritimati.parts.year,
        kiritimati.parts.month,
        kiritimati.parts.day,
        kiritimati.parts.hour,
        kiritimati.parts.minute,
        0,
        'Pacific/Kiritimati',
      ).toISOString(),
    ).toBe(ownerTimed?.startAt)
    expect(
      zonedDateTimeToUtc(
        midway.parts.year,
        midway.parts.month,
        midway.parts.day,
        midway.parts.hour,
        midway.parts.minute,
        0,
        'Pacific/Midway',
      ).toISOString(),
    ).toBe(ownerTimed?.startAt)

    const memberDay = forMember.find((item) => item.id === day.id)
    expect(memberDay?.startDate).toBe('2026-06-15')
    expect(memberDay?.endDate).toBe('2026-06-15')

    const sql = getSql()
    const stored = await sql.begin(async (tx) => {
      await tx.unsafe("set time zone 'Pacific/Kiritimati'")
      const east = await tx<{ start_date: string; start_at: Date }[]>`
        select start_date::text as start_date, start_at
        from calendar_event
        where id = ${day.id} or id = ${timed.id}
      `
      await tx.unsafe("set time zone 'Pacific/Midway'")
      const west = await tx<{ start_date: string; start_at: Date }[]>`
        select start_date::text as start_date, start_at
        from calendar_event
        where id = ${day.id}
      `
      return { east, west }
    })
    const eastDay = stored.east.find((row) => row.start_date === '2026-06-15')
    expect(eastDay?.start_date).toBe('2026-06-15')
    expect(stored.west[0]?.start_date).toBe('2026-06-15')
    const eastTimed = stored.east.find((row) => row.start_at)
    expect(new Date(eastTimed?.start_at ?? 0).toISOString()).toBe(
      '2026-06-16T01:00:00.000Z',
    )

    const columns = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'calendar_event'
    `
    const typeOf = (name: string) =>
      columns.find((column) => column.column_name === name)?.data_type
    expect(typeOf('start_at')).toBe('timestamp with time zone')
    expect(typeOf('end_at')).toBe('timestamp with time zone')
    expect(typeOf('start_date')).toBe('date')
    expect(typeOf('end_date')).toBe('date')
  })

  it('includes a month-crossing event in both months', async () => {
    const { member, created } = await teamWithMember()
    const days = await createEvent(member.user.id, created.id, {
      title: 'Site visit',
      allDay: true,
      startDate: '2026-01-30',
      endDate: '2026-02-02',
    })
    const hours = await createEvent(member.user.id, created.id, {
      title: 'Handoff',
      allDay: false,
      startAt: '2026-02-01T07:30:00Z',
      endAt: '2026-02-01T09:30:00Z',
    })
    const january = await listEvents(
      member.user.id,
      created.id,
      '2026-01',
      ZONE,
    )
    const february = await listEvents(
      member.user.id,
      created.id,
      '2026-02',
      ZONE,
    )
    expect(january.map((item) => item.id)).toEqual(
      expect.arrayContaining([days.id, hours.id]),
    )
    expect(february.map((item) => item.id)).toEqual(
      expect.arrayContaining([days.id, hours.id]),
    )

    const march = await listEvents(member.user.id, created.id, '2026-03', ZONE)
    expect(march.map((item) => item.id)).not.toContain(days.id)

    const januaryBars = layoutBars(january, '2026-01', ZONE).filter(
      (bar) => bar.eventId === days.id && bar.endCol > bar.startCol,
    )
    const februaryBars = layoutBars(february, '2026-02', ZONE).filter(
      (bar) => bar.eventId === days.id,
    )
    expect(januaryBars.length).toBeGreaterThan(0)
    expect(februaryBars.length).toBeGreaterThan(0)
    expect(januaryBars.every((bar) => bar.crossesMonth)).toBe(true)
    expect(februaryBars.every((bar) => bar.crossesMonth)).toBe(true)
  })

  it('lets any member edit and delete', async () => {
    const { owner, member, created } = await teamWithMember()
    const event = await createEvent(owner.user.id, created.id, {
      title: 'Draft',
      allDay: true,
      startDate: '2026-04-01',
      endDate: '2026-04-01',
    })
    const updated = await updateEvent(member.user.id, created.id, event.id, {
      title: 'Published',
      allDay: true,
      startDate: '2026-04-01',
      endDate: '2026-04-02',
      note: 'Bring notes',
    })
    expect(updated.title).toBe('Published')
    expect(updated.note).toBe('Bring notes')
    await deleteEvent(member.user.id, created.id, event.id)
    const left = await listEvents(owner.user.id, created.id, '2026-04', 'UTC')
    expect(left).toEqual([])
  })
})

describe('calendar zones', () => {
  it('places month boundaries on local midnight', () => {
    expect(
      monthBounds(2026, 1, 'America/Los_Angeles').start.toISOString(),
    ).toBe('2026-01-01T08:00:00.000Z')
    expect(
      monthBounds(2026, 4, 'America/Los_Angeles').start.toISOString(),
    ).toBe('2026-04-01T07:00:00.000Z')
    expect(monthBounds(2026, 1, 'Pacific/Kiritimati').start.toISOString()).toBe(
      '2025-12-31T10:00:00.000Z',
    )
  })
})
