import type { Json } from './body-text'

export type PageSavePayload = {
  pageId: string
  title: string
  body: Json
}

export type PageSaveTransport = {
  syncPost: (url: string, body: string) => boolean
  beacon: (url: string, body: string) => boolean
  fetchKeepalive: (url: string, body: string) => void
}

const SAVE_URL = '/api/pages/save'

export function deliverPageSave(
  payload: PageSavePayload,
  transport: PageSaveTransport,
) {
  const body = JSON.stringify(payload)
  try {
    if (transport.syncPost(SAVE_URL, body)) return 'sync' as const
  } catch {
    // Page dismissal can reject a synchronous request.
  }
  if (transport.beacon(SAVE_URL, body)) return 'beacon' as const
  transport.fetchKeepalive(SAVE_URL, body)
  return 'fetch' as const
}

export function browserPageSaveTransport(): PageSaveTransport {
  return {
    syncPost(url, body) {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', url, false)
      xhr.setRequestHeader('content-type', 'application/json')
      xhr.send(body)
      return xhr.status >= 200 && xhr.status < 300
    },
    beacon(url, body) {
      if (
        typeof navigator === 'undefined' ||
        typeof navigator.sendBeacon !== 'function'
      ) {
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
