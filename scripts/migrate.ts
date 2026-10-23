import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postgresPoolOptions } from '../src/lib/postgres-options'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = [join(here, 'drizzle'), join(here, '..', 'drizzle')].find((dir) =>
  existsSync(join(dir, 'meta/_journal.json')),
)
if (!migrationsFolder) {
  console.error('drizzle journal not found')
  process.exit(1)
}
const options = postgresPoolOptions(url)
const client = postgres(url, { ...options, max: 1 })

await migrate(drizzle(client), { migrationsFolder })
await client.end()
console.log('migrations applied')
