import { testDatabaseUrl } from '../tests/db-url.ts'

const savedTest = process.env.TEST_DATABASE_URL
const savedDatabase = process.env.DATABASE_URL

function restore() {
  if (savedTest === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = savedTest
  if (savedDatabase === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedDatabase
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : ''
}

function clean(message: string) {
  return (
    message.includes('TEST_DATABASE_URL') &&
    !message.includes('example.com') &&
    !message.includes('postgres://') &&
    !message.includes('localhost') &&
    !message.includes('@')
  )
}

function refused(url: string) {
  process.env.TEST_DATABASE_URL = url
  delete process.env.DATABASE_URL
  try {
    testDatabaseUrl()
    return false
  } catch (error) {
    return clean(messageOf(error))
  }
}

function acceptedLocal(url: string, host: string) {
  process.env.TEST_DATABASE_URL = url
  delete process.env.DATABASE_URL
  try {
    const parsed = new URL(testDatabaseUrl())
    const name = decodeURIComponent(parsed.hostname).replace(/^\[|\]$/g, '').toLowerCase()
    return name === host
  } catch {
    return false
  }
}

const remote = refused('postgres://u:p@db.example.com:5432/x')
const multihost = refused('postgres://u:p@db.example.com,@localhost/x')
const doubleAt = refused('postgres://u:p@db.example.com:5432,x@127.0.0.1:5432/x')
const encodedMulti = refused('postgres://u:p@db.example.com%2C127.0.0.1/x')
const ipv6 = acceptedLocal('postgres://u:p@[::1]:5432/x', '::1')
const encodedLocal = acceptedLocal('postgres://u:p@%6c%6f%63%61%6c%68%6f%73%74/db', 'localhost')
restore()

const ok = remote && multihost && doubleAt && encodedMulti && ipv6 && encodedLocal
console.log(`test_db_guard_remote_refused=${remote}`)
console.log(`test_db_guard_multihost_refused=${multihost}`)
console.log(`test_db_guard_double_at_refused=${doubleAt}`)
console.log(`test_db_guard_encoded_multihost_refused=${encodedMulti}`)
console.log(`test_db_guard_ipv6_local=${ipv6}`)
console.log(`test_db_guard_encoded_local=${encodedLocal}`)
console.log(`result=${ok ? 'pass' : 'fail'}`)
if (!ok) process.exit(1)
