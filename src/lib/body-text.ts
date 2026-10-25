import { formatDateLabel } from '#/lib/date-label'

export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json }

type TipNode = {
  type?: string
  text?: string
  attrs?: { date?: string; id?: string; label?: string }
  content?: Array<TipNode>
}

export type MentionLabel = (id: string, storedLabel: string | null) => string

export function tiptapToText(node: Json, mentionLabel?: MentionLabel): string {
  if (!node || typeof node !== 'object') {
    return ''
  }
  const n = node as TipNode
  if (n.type === 'dateChip' && typeof n.attrs?.date === 'string') {
    return formatDateLabel(n.attrs.date)
  }
  if (n.type === 'mention') {
    const id = typeof n.attrs?.id === 'string' ? n.attrs.id : ''
    const stored = typeof n.attrs?.label === 'string' ? n.attrs.label : null
    if (mentionLabel) return mentionLabel(id, stored)
    return stored || 'Unknown person'
  }
  if (typeof n.text === 'string') {
    return n.text
  }
  return (n.content ?? [])
    .map((child) => tiptapToText(child as Json, mentionLabel))
    .filter(Boolean)
    .join(' ')
}

export const emptyDoc: Json = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}
