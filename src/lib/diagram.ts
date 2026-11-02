import type { Json } from './body-text'

export function diagramIds(body: Json): string[] {
  const ids: string[] = []
  const walk = (value: Json) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    const node = value as { type?: Json; attrs?: Json; content?: Json }
    if (node.type === 'diagram') {
      const attrs = node.attrs
      if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
        const id = (attrs as { drawingId?: Json }).drawingId
        if (typeof id === 'string' && id) ids.push(id)
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child)
    }
  }
  walk(body)
  return ids
}

export function drawingLink(id: string) {
  return `[Drawing](atlas://drawing/${encodeURIComponent(id)})`
}
