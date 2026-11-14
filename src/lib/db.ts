import { AsyncLocalStorage } from 'node:async_hooks'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { postgresPoolOptions } from './postgres-options'
import * as schema from './schema'

type Database = ReturnType<typeof drizzle<typeof schema>>
type QueryDb = Pick<Database, 'select'>

// A save holds one pool connection for the whole transaction. Access checks
// that run during that transaction must reuse it, or concurrent saves deadlock.
// `open` flips off when the callback finishes, including rollback, so a timer
// started inside the transaction does not keep the finished handle.
type TxScope = { db: QueryDb; open: boolean }

const transactionDb = new AsyncLocalStorage<TxScope>()

const globalForDb = globalThis as typeof globalThis & {
  atlasSql?: ReturnType<typeof postgres>
  atlasDb?: Database
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
    const db = drizzle(getSql(), { schema })
    const run = db.transaction.bind(db)
    db.transaction = (callback, config) =>
      run(async (tx) => {
        const scope: TxScope = { db: tx, open: true }
        try {
          return await transactionDb.run(scope, () => callback(tx))
        } finally {
          scope.open = false
        }
      }, config)
    globalForDb.atlasDb = db
  }
  return globalForDb.atlasDb
}

export function getQueryDb(): QueryDb {
  const s = transactionDb.getStore()
  return s?.open ? s.db : getDb()
}

export async function closeDb() {
  if (globalForDb.atlasSql) {
    await globalForDb.atlasSql.end({ timeout: 5 })
    globalForDb.atlasSql = undefined
    globalForDb.atlasDb = undefined
  }
}
