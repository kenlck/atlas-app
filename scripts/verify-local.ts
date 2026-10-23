// Refuse anything except an http URL on localhost. Called when a driver loads.
export function assertLocalBaseUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('refusing non-local BASE_URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'http:' || !local) {
    throw new Error('refusing non-local BASE_URL')
  }
  return url.toString().replace(/\/$/, '')
}

export function stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
