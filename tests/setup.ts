import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testDatabaseUrl } from './db-url'

process.env.DATABASE_URL = testDatabaseUrl()
process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-32-chars-min'
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || 'http://localhost:3000'
process.env.ADMIN_API_SECRET =
  process.env.ADMIN_API_SECRET || 'test-admin-api-secret-32-chars-minx'

const url = process.env.DATABASE_URL
const client = postgres(url, { max: 1, onnotice: () => {} })
await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
await client.unsafe('CREATE SCHEMA public')
await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE')
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
await migrate(drizzle(client), { migrationsFolder })
await client.end()
