const SAVE_URL = '/api/drawings'

export type DrawingSavePayload = {
  pageId?: string
  drawingId?: string
  version: number
  title?: string
  elements: unknown[]
  appState: Record<string, unknown>
  previewSvg?: string | null
}

export type DrawingSaveTransport = {
  beacon: (url: string, body: string) => boolean
  fetchKeepalive: (url: string, body: string) => void
}

export function deliverDrawingSave(
  payload: DrawingSavePayload,
  transport: DrawingSaveTransport,
) {
  const body = JSON.stringify({ ...payload, files: {}, via: 'flush' })
  if (transport.beacon(SAVE_URL, body)) return 'beacon' as const
  transport.fetchKeepalive(SAVE_URL, body)
  return 'fetch' as const
}

export function browserDrawingSaveTransport(): DrawingSaveTransport {
  return {
    beacon(url, body) {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
        return false
      }
      const blob = new Blob([body], { type: 'application/json' })
      return navigator.sendBeacon(url, blob)
    },
    fetchKeepalive(url, body) {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'include',
        keepalive: true,
      })
    },
  }
}
