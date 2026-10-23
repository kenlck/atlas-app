import { describe, expect, it } from 'vitest'
import { isPooledPostgresUrl, postgresPoolOptions } from '../src/lib/postgres-options'

describe('postgresPoolOptions', () => {
  it('does not force ssl on localhost', () => {
    const options = postgresPoolOptions('postgres://atlas:atlas@127.0.0.1:5432/atlas')
    expect(options.ssl).toBe(false)
    expect(options.prepare).toBeUndefined()
  })

  it('honors sslmode=disable on a docker hostname', () => {
    const options = postgresPoolOptions(
      'postgres://atlas:atlas@atlas-pg:5432/atlas?sslmode=disable',
    )
    expect(options.ssl).toBe(false)
  })

  it('requires ssl and disables prepare on a pooled host', () => {
    const url = 'postgres://u:p@app-pooler.us-east-1.aws.example.com:5432/db'
    const options = postgresPoolOptions(url)
    expect(options.ssl).toBe('require')
    expect(options.prepare).toBe(false)
    expect(isPooledPostgresUrl(new URL(url))).toBe(true)
  })

  it('requires ssl on a remote direct host', () => {
    const options = postgresPoolOptions('postgres://u:p@db.example.com:5432/db')
    expect(options.ssl).toBe('require')
    expect(options.prepare).toBeUndefined()
  })
})
