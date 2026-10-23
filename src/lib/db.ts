import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { postgresPoolOptions } from './postgres-options'
import * as schema from './schema'

const globalForDb = globalThis as typeof globalThis & {
  atlasSql?: ReturnType<typeof postgres>
  atlasDb?: ReturnType<typeof drizzle<typeof schema>>
}

function databaseUrl() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required')
  }
  return url
}

export function getSql() {
  if (!globalForDb.atlasSql) {
    const url = databaseUrl()
    globalForDb.atlasSql = postgres(url, postgresPoolOptions(url))
  }
  return globalForDb.atlasSql
}

export function getDb() {
  if (!globalForDb.atlasDb) {
    globalForDb.atlasDb = drizzle(getSql(), { schema })
  }
  return globalForDb.atlasDb
}

export async function closeDb() {
  if (globalForDb.atlasSql) {
    await globalForDb.atlasSql.end({ timeout: 5 })
    globalForDb.atlasSql = undefined
    globalForDb.atlasDb = undefined
  }
}
