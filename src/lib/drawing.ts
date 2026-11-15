import { generateNKeysBetween } from 'fractional-indexing'
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

type SceneElement = Record<string, unknown>

const restoredStroke = '#' + '1e1e1e'

const LINE_HEIGHT: Record<number, number> = {
  1: 1.25,
  2: 1.15,
  3: 1.2,
  5: 1.25,
  6: 1.35,
  7: 1.15,
  8: 1.25,
  9: 1.15,
}

// @excalidraw/excalidraw does not load in Node (roughjs), so both sides of a
// scene compare are filled with the defaults restoreElements adds.
function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function box(element: SceneElement) {
  let width = element.width ? finiteNumber(element.width, 0) : 0
  let height = element.height ? finiteNumber(element.height, 0) : 0
  let x = finiteNumber(element.x, 0)
  let y = finiteNumber(element.y, 0)
  if (width < 0) {
    x += width
    width = Math.abs(width)
  }
  if (height < 0) {
    y += height
    height = Math.abs(height)
  }
  return { x, y, width, height }
}

function boundElements(element: SceneElement) {
  if (Array.isArray(element.boundElementIds)) {
    return element.boundElementIds.map((id) => ({ type: 'arrow', id }))
  }
  return Array.isArray(element.boundElements) ? element.boundElements : []
}

function roundness(element: SceneElement) {
  if (element.roundness && typeof element.roundness === 'object')
    return element.roundness
  if (element.strokeSharpness !== 'round') return null
  const legacy =
    element.type === 'rectangle' ||
    element.type === 'embeddable' ||
    element.type === 'iframe' ||
    element.type === 'image'
  return { type: legacy ? 1 : 2 }
}

function lineCount(text: string) {
  return text.split('\n').length || 1
}

function textLineHeight(element: SceneElement) {
  if (typeof element.lineHeight === 'number' && element.lineHeight)
    return element.lineHeight
  const fontFamily =
    typeof element.fontFamily === 'number' ? element.fontFamily : 5
  const fallback = LINE_HEIGHT[fontFamily] ?? 1.25
  const height = typeof element.height === 'number' ? element.height : 0
  const fontSize = typeof element.fontSize === 'number' ? element.fontSize : 0
  if (height && fontSize) {
    const text = typeof element.text === 'string' ? element.text : ''
    return height / lineCount(text) / fontSize
  }
  return fallback
}

function textFields(element: SceneElement) {
  const text =
    typeof element.text === 'string' && element.text ? element.text : ''
  const fields: SceneElement = {
    fontSize: element.fontSize,
    fontFamily: element.fontFamily,
    text,
    textAlign: element.textAlign || 'left',
    verticalAlign: element.verticalAlign || 'top',
    containerId: element.containerId ?? null,
    originalText: element.originalText || text,
    autoResize: element.autoResize ?? true,
    lineHeight: textLineHeight(element),
  }
  if (!text && element.isDeleted !== true) fields.isDeleted = true
  return fields
}

function linearFields(element: SceneElement, arrow: boolean) {
  const width = element.width ? finiteNumber(element.width, 0) : 0
  const height = element.height ? finiteNumber(element.height, 0) : 0
  const points =
    Array.isArray(element.points) && element.points.length >= 2
      ? element.points
      : [
          [0, 0],
          [width, height],
        ]
  return {
    points,
    lastCommittedPoint: null,
    startBinding: element.startBinding ?? null,
    endBinding: element.endBinding ?? null,
    startArrowhead:
      element.startArrowhead === undefined ? null : element.startArrowhead,
    endArrowhead: arrow
      ? element.endArrowhead === undefined
        ? 'arrow'
        : element.endArrowhead
      : element.endArrowhead === undefined
        ? null
        : element.endArrowhead,
  }
}

function fillElement(value: unknown): SceneElement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const element = { ...(value as SceneElement) }
  if (element.type === 'selection' || element.type === 'draw') {
    if (element.type === 'selection') return null
    element.type = 'line'
  }
  if (
    typeof element.type !== 'string' ||
    typeof element.id !== 'string' ||
    !element.id
  )
    return null
  const shaped = box(element)
  const filled: SceneElement = {
    ...element,
    type: element.type,
    id: element.id,
    isDeleted: element.isDeleted ?? false,
    fillStyle: element.fillStyle || 'solid',
    strokeWidth: element.strokeWidth || 2,
    strokeStyle: element.strokeStyle ?? 'solid',
    roughness: element.roughness ?? 1,
    opacity: element.opacity == null ? 100 : element.opacity,
    angle: element.angle || 0,
    ...shaped,
    strokeColor: element.strokeColor || restoredStroke,
    backgroundColor: element.backgroundColor || 'transparent',
    groupIds: element.groupIds ?? [],
    frameId: element.frameId ?? null,
    roundness: roundness(element),
    boundElements: boundElements(element),
    link: element.link || null,
    locked: element.locked ?? false,
  }
  if (element.type === 'text') Object.assign(filled, textFields(element))
  if (element.type === 'line')
    Object.assign(filled, linearFields(element, false))
  if (element.type === 'arrow')
    Object.assign(filled, linearFields(element, true))
  if (element.type === 'freedraw') filled.lastCommittedPoint = null
  if (element.type === 'image') {
    filled.status = element.status || 'pending'
    filled.scale = element.scale || [1, 1]
    filled.crop = element.crop ?? null
  }
  if (element.type === 'frame' || element.type === 'magicframe')
    filled.name = element.name ?? null
  return filled
}

function elementIndex(element: SceneElement | undefined) {
  const index = element?.index
  return typeof index === 'string' && index.length > 0 ? index : null
}

function validIndex(
  index: string | null,
  predecessor: string | null,
  successor: string | null,
) {
  if (!index) return false
  if (predecessor && successor) return predecessor < index && index < successor
  if (!predecessor && successor) return index < successor
  if (predecessor && !successor) return predecessor < index
  return true
}

function invalidIndexGroups(elements: SceneElement[]) {
  const groups: number[][] = []
  let lowerBound: string | null = null
  let upperBound: string | null = null
  let lowerBoundIndex = -1
  let upperBoundIndex = 0
  const lower = (index: number): [string | null, number] => {
    const bound = elementIndex(elements[lowerBoundIndex])
    const candidate = elementIndex(elements[index - 1])
    if ((!bound && candidate) || (bound && candidate && candidate > bound)) {
      return [candidate, index - 1]
    }
    return [bound, lowerBoundIndex]
  }
  const upper = (index: number): [string | null, number] => {
    const bound = elementIndex(elements[upperBoundIndex])
    if (bound && index < upperBoundIndex) return [bound, upperBoundIndex]
    let cursor = upperBoundIndex
    while (++cursor < elements.length) {
      const candidate = elementIndex(elements[cursor])
      if ((!bound && candidate) || (bound && candidate && candidate > bound)) {
        return [candidate, cursor]
      }
    }
    return [null, cursor]
  }
  let index = 0
  while (index < elements.length) {
    ;[lowerBound, lowerBoundIndex] = lower(index)
    ;[upperBound, upperBoundIndex] = upper(index)
    if (!validIndex(elementIndex(elements[index]), lowerBound, upperBound)) {
      const group = [lowerBoundIndex, index]
      while (++index < elements.length) {
        const [nextLower, nextLowerIndex] = lower(index)
        const [nextUpper, nextUpperIndex] = upper(index)
        if (validIndex(elementIndex(elements[index]), nextLower, nextUpper))
          break
        lowerBound = nextLower
        lowerBoundIndex = nextLowerIndex
        upperBound = nextUpper
        upperBoundIndex = nextUpperIndex
        group.push(index)
      }
      group.push(upperBoundIndex)
      groups.push(group)
    } else {
      index += 1
    }
  }
  return groups
}

function fillIndexes(elements: SceneElement[]) {
  for (const group of invalidIndexGroups(elements)) {
    const lowerIndex = group.shift() ?? -1
    const upperIndex = group.pop() ?? elements.length
    const keys = generateNKeysBetween(
      elementIndex(elements[lowerIndex]),
      elementIndex(elements[upperIndex]),
      group.length,
    )
    group.forEach((at, position) => {
      elements[at] = { ...elements[at], index: keys[position] }
    })
  }
  return elements
}

export function restoreSceneElements(elements: unknown[]) {
  const filled = elements.flatMap((element) => {
    const next = fillElement(element)
    return next ? [next] : []
  })
  return fillIndexes(filled)
}

export function sceneChanged(stored: unknown[], incoming: unknown[]) {
  return (
    canonicalElements(restoreSceneElements(stored)) !==
    canonicalElements(restoreSceneElements(incoming))
  )
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
