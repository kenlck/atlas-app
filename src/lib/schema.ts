import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
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
})

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
