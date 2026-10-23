import { isLocalPostgresHost } from '../src/lib/postgres-options'

export function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL
  }
  const url = process.env.DATABASE_URL
  if (url) {
    try {
      const parsed = new URL(url)
      if (isLocalPostgresHost(parsed.hostname)) {
        return url
      }
    } catch {
      // fall through to the local test database
    }
  }
  return 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test'
}
