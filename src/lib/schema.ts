import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastSpaceId: text('last_space_id').references((): AnyPgColumn => space.id, {
    onDelete: 'set null',
  }),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
})

export const apiTokenScope = pgEnum('api_token_scope', ['read', 'read_write'])
export const spaceKind = pgEnum('space_kind', ['personal', 'team'])
export const teamRole = pgEnum('team_role', ['owner', 'member'])
export const inviteStatus = pgEnum('invite_status', [
  'pending',
  'accepted',
  'declined',
])
export const team = pgTable('team', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull(),
})

export const teamMember = pgTable(
  'team_member',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: teamRole('role').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    uniqueIndex('team_one_owner')
      .on(t.teamId)
      .where(sql`role = 'owner'`),
  ],
)

export const teamInvite = pgTable(
  'team_invite',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    inviteeUserId: text('invitee_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id),
    status: inviteStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('team_invite_one_pending')
      .on(t.teamId, t.inviteeUserId)
      .where(sql`status = 'pending'`),
  ],
)

export const space = pgTable(
  'space',
  {
    id: text('id').primaryKey(),
    kind: spaceKind('kind').notNull(),
    teamId: text('team_id').references(() => team.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => user.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    check(
      'space_kind_owner',
      sql`(
        (kind = 'personal' AND owner_user_id IS NOT NULL AND team_id IS NULL)
        OR
        (kind = 'team' AND team_id IS NOT NULL AND owner_user_id IS NULL)
      )`,
    ),
    uniqueIndex('space_one_personal_per_owner')
      .on(t.ownerUserId)
      .where(sql`kind = 'personal'`),
    uniqueIndex('space_one_per_team')
      .on(t.teamId)
      .where(sql`team_id IS NOT NULL`),
  ],
)

export const apiToken = pgTable(
  'api_token',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    scope: apiTokenScope('scope').notNull(),
    expiresAt: timestamp('expires_at'),
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('api_token_hash_unique').on(t.tokenHash),
    index('api_token_user_idx').on(t.userId),
  ],
)

export const page = pgTable('page', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  body: jsonb('body').notNull(),
  bodyText: text('body_text').notNull().default(''),
  position: integer('position').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id),
  updatedBy: text('updated_by')
    .notNull()
    .references(() => user.id),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  archivedAt: timestamp('archived_at'),
  updatedViaTokenId: text('updated_via_token_id').references(
    () => apiToken.id,
    {
      onDelete: 'set null',
    },
  ),
})

export const calendarEvent = pgTable(
  'calendar_event',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    allDay: boolean('all_day').notNull(),
    startAt: timestamp('start_at', { withTimezone: true, mode: 'date' }),
    endAt: timestamp('end_at', { withTimezone: true, mode: 'date' }),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    note: text('note'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    updatedBy: text('updated_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    check(
      'calendar_event_shape',
      sql`(
        (
          all_day = true
          AND start_date IS NOT NULL
          AND end_date IS NOT NULL
          AND start_at IS NULL
          AND end_at IS NULL
          AND end_date >= start_date
        )
        OR
        (
          all_day = false
          AND start_at IS NOT NULL
          AND end_at IS NOT NULL
          AND start_date IS NULL
          AND end_date IS NULL
          AND end_at >= start_at
        )
      )`,
    ),
    index('calendar_event_team_start_at_idx').on(t.teamId, t.startAt),
    index('calendar_event_team_start_date_idx').on(t.teamId, t.startDate),
  ],
)

export const adminAudit = pgTable('admin_audit', {
  id: text('id').primaryKey(),
  action: text('action').notNull(),
  targetUserId: text('target_user_id')
    .notNull()
    .references(() => user.id),
  callerIp: text('caller_ip'),
  createdAt: timestamp('created_at').notNull(),
})

export type User = typeof user.$inferSelect
export type Space = typeof space.$inferSelect
export type Page = typeof page.$inferSelect
export type AdminAudit = typeof adminAudit.$inferSelect
export type Team = typeof team.$inferSelect
export type TeamMember = typeof teamMember.$inferSelect
export type TeamInvite = typeof teamInvite.$inferSelect
export type CalendarEvent = typeof calendarEvent.$inferSelect
export type ApiToken = typeof apiToken.$inferSelect
