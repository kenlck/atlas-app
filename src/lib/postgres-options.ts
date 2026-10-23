import type postgres from 'postgres'

export function isLocalPostgresHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function isPooledPostgresUrl(url: URL) {
  const host = url.hostname.toLowerCase()
  return (
    host.includes('pooler') ||
    url.port === '6432' ||
    url.searchParams.get('pgbouncer') === 'true'
  )
}

export function postgresPoolOptions(connectionString: string): postgres.Options<{}> {
  const url = new URL(connectionString)
  const local = isLocalPostgresHost(url.hostname)
  const pooled = isPooledPostgresUrl(url)
  const sslmode = url.searchParams.get('sslmode')
  const options: postgres.Options<{}> = {
    max: 10,
    onnotice: () => {},
  }
  if (sslmode === 'disable' || local) {
    options.ssl = false
  } else {
    options.ssl = 'require'
  }
  if (pooled) {
    options.prepare = false
  }
  return options
}
