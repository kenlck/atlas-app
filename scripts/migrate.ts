import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { postgresPoolOptions } from '../src/lib/postgres-options'

// Session lock held for the whole migrate() call, on its own connection.
// Keep this key fixed so concurrent starts wait on the same lock.
const MIGRATION_LOCK_KEY = '902100111420261114'

function redact(text: string) {
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\bpassword=[^\s&]+/gi, 'password=[redacted]')
}

function errorText(error: unknown) {
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      if (inner instanceof Error && inner.message) return inner.message
    }
  }
  if (error instanceof Error && error.message) return error.message
  return 'migration failed'
}

function fail(message: string): never {
  console.error(redact(message))
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) fail('DATABASE_URL is required')

const here = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = [join(here, 'drizzle'), join(here, '..', 'drizzle')].find(
  (dir) => existsSync(join(dir, 'meta/_journal.json')),
)
if (!migrationsFolder) fail('drizzle journal not found')

const options = postgresPoolOptions(url)
const lock = postgres(url, { ...options, max: 1 })
const client = postgres(url, { ...options, max: 1 })
let code = 0
let locked = false

try {
  await lock`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`
  locked = true
  await migrate(drizzle(client), { migrationsFolder })
} catch (error) {
  console.error(`migration failed: ${redact(errorText(error))}`)
  code = 1
} finally {
  if (locked) {
    try {
      await lock`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`
    } catch (error) {
      console.error(`migration lock release failed: ${redact(errorText(error))}`)
      code = 1
    }
  }
  await client.end({ timeout: 5 }).catch(() => undefined)
  await lock.end({ timeout: 5 }).catch(() => undefined)
}

if (code !== 0) process.exit(code)
console.log('migrations applied')
