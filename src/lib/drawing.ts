import type { Json } from './body-text'

export const DRAWING_MAX_BYTES = 2 * 1024 * 1024
export const BOARD_CONFLICT = 'board changed, reload'
export const WHITEBOARD_PLACEHOLDER = 'Whiteboard, open in Atlas to view'

export type DrawingScene = {
  elements: Json[]
  appState: { [key: string]: Json }
}

export const emptyScene: DrawingScene = { elements: [], appState: {} }

export function drawingLabelText(elements: unknown[]) {
  const parts: string[] = []
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue
    const record = element as Record<string, unknown>
    if (record.isDeleted === true) continue
    if (record.type !== 'text') continue
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

export function plainAppState(value: unknown): { [key: string]: Json } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'collaborators' || typeof item === 'function') continue
    copy[key] = item
  }
  try {
    const parsed = JSON.parse(JSON.stringify(copy)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as { [key: string]: Json }
  } catch {
    return {}
  }
}

export function plainElements(value: unknown): Json[] | null {
  if (!Array.isArray(value)) return null
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as unknown
    return Array.isArray(parsed) ? (parsed as Json[]) : null
  } catch {
    return null
  }
}

export function sceneFromStored(value: unknown): DrawingScene {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyScene
  const record = value as Record<string, unknown>
  return {
    elements: Array.isArray(record.elements) ? (record.elements as Json[]) : [],
    appState: plainAppState(record.appState),
  }
}

// Rejects embedded images. An empty files map is a scene with no binaries.
export function sceneRejection(input: {
  files: unknown
  elements: unknown[]
}): 'files' | 'image' | null {
  if (input.files != null) {
    if (typeof input.files !== 'object' || Array.isArray(input.files)) return 'files'
    if (Object.keys(input.files as Record<string, unknown>).length > 0) return 'files'
  }
  for (const element of input.elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue
    if ((element as { type?: unknown }).type === 'image') return 'image'
  }
  return null
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const copy = { ...(value as Record<string, unknown>) }
  delete copy.version
  delete copy.versionNonce
  delete copy.updated
  delete copy.seed
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(copy).sort()) sorted[key] = stableValue(copy[key])
  return sorted
}

export function canonicalElements(elements: unknown[]) {
  return JSON.stringify(stableValue(elements))
}
