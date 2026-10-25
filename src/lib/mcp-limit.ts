export const MCP_MAX_BODY_BYTES = 1024 * 1024
export const MCP_RATE_MAX = 60
export const MCP_RATE_WINDOW_MS = 60 * 1000

type Hit = { times: number[] }
const hits = new Map<string, Hit>()

export function resetMcpRateLimit() {
  hits.clear()
}

export function allowMcpRequest(tokenId: string) {
  const now = Date.now()
  const current = hits.get(tokenId) ?? { times: [] }
  current.times = current.times.filter((time) => now - time < MCP_RATE_WINDOW_MS)
  if (current.times.length >= MCP_RATE_MAX) {
    hits.set(tokenId, current)
    return false
  }
  current.times.push(now)
  hits.set(tokenId, current)
  return true
}
