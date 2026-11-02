import { assertLocalDatabaseUrl } from './verify-local.ts'

const requireDatabase = process.argv.includes('--require')

function check(name: 'DATABASE_URL' | 'TEST_DATABASE_URL', required: boolean) {
  const raw = process.env[name]
  if (!raw) {
    if (!required) return
    console.error(`refusing non-local ${name}`)
    process.exit(2)
  }
  try {
    assertLocalDatabaseUrl(raw)
  } catch {
    console.error(`refusing non-local ${name}`)
    process.exit(2)
  }
}

check('DATABASE_URL', requireDatabase)
check('TEST_DATABASE_URL', false)
