import { testDatabaseUrl } from '../tests/db-url.ts'

const savedTest = process.env.TEST_DATABASE_URL
const savedDatabase = process.env.DATABASE_URL
process.env.TEST_DATABASE_URL = 'postgres://u:p@db.example.com:5432/x'
delete process.env.DATABASE_URL

let refused = false
try {
  testDatabaseUrl()
} catch (error) {
  const message = error instanceof Error ? error.message : ''
  refused =
    message.includes('TEST_DATABASE_URL') &&
    !message.includes('example.com') &&
    !message.includes('postgres://')
} finally {
  if (savedTest === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = savedTest
  if (savedDatabase === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedDatabase
}

console.log(`test_db_guard_remote_refused=${refused}`)
console.log(`result=${refused ? 'pass' : 'fail'}`)
if (!refused) process.exit(1)
