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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return emptyScene
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
    if (typeof input.files !== 'object' || Array.isArray(input.files))
      return 'files'
    if (Object.keys(input.files).length > 0) return 'files'
  }
  for (const element of input.elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element))
      continue
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
  for (const key of Object.keys(copy).sort())
    sorted[key] = stableValue(copy[key])
  return sorted
}

export function canonicalElements(elements: unknown[]) {
  return JSON.stringify(stableValue(elements))
}

function elementRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

// Font measurement, a filled-in index, and an image file finishing its load
// are Excalidraw's own work. A person did not edit the scene.
function comparableElement(value: unknown, dropIndex: boolean) {
  const record = elementRecord(value)
  if (!record) return value
  const copy: Record<string, unknown> = { ...record }
  if (dropIndex) delete copy.index
  if (copy.type === 'text') {
    delete copy.width
    delete copy.height
    delete copy.baseline
    delete copy.originalText
    delete copy.lineHeight
  }
  if (copy.type === 'image') delete copy.status
  return stableValue(copy)
}

export function userSceneChanged(previous: unknown[], next: unknown[]) {
  if (previous.length !== next.length) return true
  for (let i = 0; i < previous.length; i += 1) {
    const before = elementRecord(previous[i])
    const after = elementRecord(next[i])
    const indexFilled =
      !!before &&
      !!after &&
      (before.index === undefined || before.index === null) &&
      after.index !== undefined &&
      after.index !== null
    if (
      JSON.stringify(comparableElement(previous[i], indexFilled)) !==
      JSON.stringify(comparableElement(next[i], indexFilled))
    ) {
      return true
    }
  }
  return false
}

function imageStatusMoved(previous: unknown[], next: unknown[]) {
  const statuses = new Map<string, unknown>()
  for (const element of previous) {
    const record = elementRecord(element)
    if (record?.type === 'image' && typeof record.id === 'string')
      statuses.set(record.id, record.status ?? null)
  }
  for (const element of next) {
    const record = elementRecord(element)
    if (record?.type !== 'image' || typeof record.id !== 'string') continue
    if (!statuses.has(record.id)) continue
    if ((record.status ?? null) !== statuses.get(record.id)) return true
  }
  return false
}

// After a save leaves the browser, a later image status is still that edit.
// A font measurement that landed in the same gap is not.
export function sceneFollowup(sent: unknown[], current: unknown[]) {
  if (canonicalElements(sent) === canonicalElements(current)) return 'same' as const
  if (userSceneChanged(sent, current) || imageStatusMoved(sent, current))
    return 'save' as const
  return 'adopt' as const
}

export function sceneChanged(stored: unknown[], incoming: unknown[]) {
  return canonicalElements(stored) !== canonicalElements(incoming)
}

// Stored previews are SVG text on the drawing row. Scripts and handlers are removed.
export function cleanPreviewSvg(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let svg = value.trim().replace(/^\s*<\?xml[^?]*\?>\s*/i, '')
  if (!svg || svg.length > 500_000) return null
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return null
  if (!/^<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return null
  svg = svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*\/?>/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (match) =>
      match.startsWith('/') ? '/' : '',
    )
    .replace(
      /\s(?:href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi,
      '',
    )
    .replace(/javascript:/gi, '')
  if (/<script\b|[\s/]on[a-z]+\s*=|javascript:/i.test(svg)) return null
  if (!/^<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return null
  return svg
}
