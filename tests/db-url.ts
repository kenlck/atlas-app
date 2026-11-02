import { isLocalPostgresHost } from '../src/lib/postgres-options'

const DEFAULT_TEST_URL = 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test'

function localOrThrow(source: 'TEST_DATABASE_URL' | 'DATABASE_URL' | 'default test database', raw: string) {
  let hostname = ''
  try {
    hostname = new URL(raw).hostname
  } catch {
    throw new Error(`${source} must be a local database`)
  }
  if (!isLocalPostgresHost(hostname)) {
    throw new Error(`${source} must be a local database`)
  }
  return raw
}

export function testDatabaseUrl() {
  const fromTest = process.env.TEST_DATABASE_URL
  if (fromTest) return localOrThrow('TEST_DATABASE_URL', fromTest)
  const fromDatabase = process.env.DATABASE_URL
  if (fromDatabase) return localOrThrow('DATABASE_URL', fromDatabase)
  return localOrThrow('default test database', DEFAULT_TEST_URL)
}
