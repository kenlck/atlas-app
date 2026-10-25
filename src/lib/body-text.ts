import { formatDateLabel } from '#/lib/date-label'

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json }

type TipNode = {
  type?: string
  text?: string
  attrs?: { date?: string }
  content?: Array<TipNode>
}

export function tiptapToText(node: Json): string {
  if (!node || typeof node !== 'object') {
    return ''
  }
  const n = node as TipNode
  if (n.type === 'dateChip' && typeof n.attrs?.date === 'string') {
    return formatDateLabel(n.attrs.date)
  }
  if (typeof n.text === 'string') {
    return n.text
  }
  return (n.content ?? [])
    .map((child) => tiptapToText(child as Json))
    .filter(Boolean)
    .join(' ')
}

export const emptyDoc: Json = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}
