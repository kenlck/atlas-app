// Hop count from the right of X-Forwarded-For. 1 is the rightmost entry.
export const TRUSTED_PROXY_HOPS = 1

export function trustProxyEnabled() {
  const value = process.env.TRUST_PROXY?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function trustedProxyHops() {
  const raw = process.env.TRUSTED_PROXY_HOPS
  if (raw == null) return TRUSTED_PROXY_HOPS
  const trimmed = raw.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error('TRUSTED_PROXY_HOPS must be a positive integer')
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('TRUSTED_PROXY_HOPS must be a positive integer')
  }
  return parsed
}

export function forwardedClientIp(
  header: string | null | undefined,
  hops = trustedProxyHops(),
) {
  const parts = (header ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (hops < 1 || parts.length < hops) return null
  return parts[parts.length - hops] ?? null
}

export function resolveClientIp(request: Request, socketIp?: string | null) {
  if (trustProxyEnabled()) {
    const picked = forwardedClientIp(request.headers.get('x-forwarded-for'))
    if (picked) return picked
  }
  const socket = socketIp?.trim()
  return socket || 'unknown'
}

// better-auth 1.7 reads one X-Forwarded-For value (a list is not trusted unless
// every proxy IP is configured). Pass the hop this module already chose so the
// sign-in limiter and the admin limiter use the same address.
// The node server's request is instanceof Request but has no native state, so
// new Request(request) throws. Build one from the URL instead.
export function requestWithClientIp(request: Request, socketIp?: string | null) {
  const headers = new Headers(request.headers)
  const ip = resolveClientIp(request, socketIp)
  if (ip === 'unknown') headers.delete('x-forwarded-for')
  else headers.set('x-forwarded-for', ip)
  const method = request.method
  const body = method === 'GET' || method === 'HEAD' ? null : request.body
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    signal: request.signal,
  }
  if (body) {
    init.body = body
    init.duplex = 'half'
  }
  return new Request(request.url, init)
}
