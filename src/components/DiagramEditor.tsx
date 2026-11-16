import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { exportToSvg } from '@excalidraw/excalidraw'
import { listenForEngage } from './editor-engage'
import {
  canonicalElements,
  cleanPreviewSvg,
  drawingLabelText,
  plainAppState,
  sceneFollowup,
  userSceneChanged,
} from '#/lib/drawing'
import {
  browserDrawingSaveTransport,
  deliverDrawingSave,
} from '#/lib/drawing-keepalive'

type SaveState = 'saved' | 'saving' | 'error' | 'conflict'

type CanvasProps = {
  elements: unknown[]
  appState: Record<string, unknown>
  viewMode: boolean
  onScene: (elements: unknown[], appState: Record<string, unknown>) => void
  onEngage?: () => void
}

export type DiagramEditorProps = {
  drawingId: string
  pageId: string
  onClose: () => void
  onPreview: (svg: string | null) => void
}

const SAVE_URL = '/api/drawings'

function fallbackSvg(elements: unknown[]) {
  const label = drawingLabelText(elements)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"><text x="16" y="32">${label}</text></svg>`
}

async function renderPreview(elements: unknown[], appState: Record<string, unknown>) {
  try {
    const svg = await exportToSvg({
      elements: elements as never,
      appState: appState as never,
      files: {},
      skipInliningFonts: true,
    })
    return cleanPreviewSvg(svg.outerHTML) ?? cleanPreviewSvg(fallbackSvg(elements))
  } catch {
    return cleanPreviewSvg(fallbackSvg(elements))
  }
}

export function DiagramEditor({ drawingId, pageId, onClose, onPreview }: DiagramEditorProps) {
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [narrow, setNarrow] = useState(false)
  const [ready, setReady] = useState(false)
  const [Canvas, setCanvas] = useState<ComponentType<CanvasProps> | null>(null)
  const [initial, setInitial] = useState<{
    elements: unknown[]
    appState: Record<string, unknown>
  } | null>(null)
  const elementsRef = useRef<unknown[]>([])
  const appStateRef = useRef<Record<string, unknown>>({})
  const versionRef = useRef(1)
  const savedCanon = useRef('')
  const baselineElements = useRef<unknown[]>([])
  const baselineReady = useRef(false)
  const engaged = useRef(false)
  const unlisten = useRef<(() => void) | null>(null)
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState
  const previewRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followSave = useRef<() => void>(() => {})
  const drawingIdRef = useRef(drawingId)
  const previewToken = useRef(0)

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const payload = (via: 'autosave' | 'flush') => {
    const body: {
      drawingId: string
      version: number
      elements: unknown[]
      appState: Record<string, unknown>
      files: Record<string, never>
      via: 'autosave' | 'flush'
      previewSvg?: string
    } = {
      drawingId: drawingIdRef.current,
      version: versionRef.current,
      elements: elementsRef.current,
      appState: appStateRef.current,
      files: {},
      via,
    }
    if (previewRef.current) body.previewSvg = previewRef.current
    return body
  }

  const queuePreview = () => {
    const token = previewToken.current + 1
    previewToken.current = token
    const elements = elementsRef.current
    const appState = appStateRef.current
    void renderPreview(elements, appState).then((svg) => {
      if (token !== previewToken.current || !svg) return
      previewRef.current = svg
      onPreview(svg)
    })
  }

  const adopt = (elements: unknown[]) => {
    baselineElements.current = elements
    savedCanon.current = canonicalElements(elements)
    baselineReady.current = true
  }

  const applyResult = async (response: Response, sentElements: unknown[]) => {
    if (response.status === 409) {
      dirtyRef.current = false
      setSaveState('conflict')
      return false
    }
    if (!response.ok) {
      dirtyRef.current = true
      setSaveState('error')
      return false
    }
    const body = (await response.json()) as { version?: number }
    if (typeof body.version === 'number') versionRef.current = body.version
    const follow = sceneFollowup(sentElements, elementsRef.current)
    if (follow === 'save') {
      baselineElements.current = sentElements
      savedCanon.current = canonicalElements(sentElements)
      followSave.current()
    } else if (follow === 'adopt') {
      adopt(elementsRef.current)
      dirtyRef.current = false
      setSaveState('saved')
    } else {
      adopt(sentElements)
      dirtyRef.current = false
      setSaveState('saved')
    }
    if (previewRef.current) onPreview(previewRef.current)
    return true
  }

  const flushSave = async () => {
    clearTimer()
    if (saveState === 'conflict') return false
    if (!dirtyRef.current) return true
    const sentElements = elementsRef.current
    const body = JSON.stringify(payload('autosave'))
    dirtyRef.current = false
    setSaveState('saving')
    try {
      const response = await fetch(SAVE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body,
      })
      return await applyResult(response, sentElements)
    } catch {
      dirtyRef.current = true
      setSaveState('error')
      return false
    }
  }
  const flushSaveRef = useRef(flushSave)
  flushSaveRef.current = flushSave

  const schedule = () => {
    if (saveStateRef.current === 'conflict') return
    dirtyRef.current = true
    setSaveState('saving')
    clearTimer()
    timer.current = setTimeout(() => {
      void flushSaveRef.current()
    }, 800)
  }
  followSave.current = schedule

  useEffect(() => {
    const cancel = { current: false }
    void (async () => {
      const response = await fetch(
        `/api/drawings?drawingId=${encodeURIComponent(drawingId)}`,
        { credentials: 'include' },
      )
      if (cancel.current) return
      if (!response.ok) return
      const data = (await response.json()) as {
        pageId?: string
        version?: number
        elements?: unknown[]
        appState?: Record<string, unknown>
        previewSvg?: string | null
      }
      if (data.pageId !== pageId) return
      const elements = Array.isArray(data.elements) ? data.elements : []
      const appState = data.appState ?? {}
      elementsRef.current = elements
      appStateRef.current = appState
      versionRef.current = typeof data.version === 'number' ? data.version : 1
      savedCanon.current = ''
      baselineElements.current = []
      baselineReady.current = false
      engaged.current = false
      previewRef.current = typeof data.previewSvg === 'string' ? data.previewSvg : null
      setInitial({ elements, appState })
      setReady(true)
    })()
    return () => {
      cancel.current = true
    }
  }, [drawingId, pageId])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void import('./WhiteboardCanvas').then((mod) => {
      if (!cancelled) setCanvas(() => mod.WhiteboardCanvas)
    })
    return () => {
      cancelled = true
    }
  }, [ready])

  const bindCanvas = useCallback((node: HTMLDivElement | null) => {
    unlisten.current?.()
    unlisten.current = null
    if (!node) return
    unlisten.current = listenForEngage(node, () => {
      engaged.current = true
    })
  }, [])

  useEffect(() => () => unlisten.current?.(), [])

  useEffect(() => {
    return () => {
      if (!dirtyRef.current || saveStateRef.current === 'conflict') return
      clearTimer()
      const snapshot = payload('flush')
      dirtyRef.current = false
      versionRef.current += 1
      deliverDrawingSave(snapshot, browserDrawingSaveTransport())
    }
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)')
    const apply = () => setNarrow(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return
      clearTimer()
      if (!dirtyRef.current || saveState === 'conflict') return
      const snapshot = payload('flush')
      dirtyRef.current = false
      versionRef.current += 1
      deliverDrawingSave(snapshot, browserDrawingSaveTransport())
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [saveState])

  const done = async () => {
    const token = previewToken.current + 1
    previewToken.current = token
    const svg = await renderPreview(elementsRef.current, appStateRef.current)
    if (svg && token === previewToken.current) {
      previewRef.current = svg
      onPreview(svg)
    }
    const next = canonicalElements(elementsRef.current)
    if (baselineReady.current && next !== savedCanon.current) dirtyRef.current = true
    const ok = await flushSaveRef.current()
    if (ok) onClose()
  }

  return (
    <div className="diagram-screen" role="dialog" aria-label="Drawing">
      <div className="diagram-bar">
        <button type="button" onClick={() => void done()}>
          Done
        </button>
        <span className="save">
          {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : ''}
        </span>
      </div>
      {saveState === 'error' ? (
        <div className="retry">
          Couldn't save.
          <button type="button" onClick={() => void flushSave()}>
            Retry
          </button>
        </div>
      ) : null}
      {saveState === 'conflict' ? (
        <div className="retry" role="alert">
          board changed, reload
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}
      <div className="board-canvas" ref={bindCanvas}>
        {Canvas && initial ? (
          <Canvas
            key={drawingId}
            elements={initial.elements}
            appState={initial.appState}
            viewMode={narrow}
            onEngage={() => {
              engaged.current = true
            }}
            onScene={(elements, appState) => {
              elementsRef.current = elements
              appStateRef.current = plainAppState(appState)
              // The first scene is the restore, even if a click landed first.
              if (!baselineReady.current) {
                adopt(elements)
                return
              }
              // Fonts, a filled-in index, and an image status are not edits.
              // A status that belongs to an edit already in flight stays dirty.
              if (!userSceneChanged(baselineElements.current, elements)) {
                if (!dirtyRef.current) adopt(elements)
                return
              }
              const next = canonicalElements(elements)
              if (next === savedCanon.current) return
              engaged.current = true
              queuePreview()
              schedule()
            }}
          />
        ) : (
          <div className="diagram-spin-wrap">
            <div className="diagram-spin" role="status" aria-label="Loading drawing" />
          </div>
        )}
      </div>
    </div>
  )
}
