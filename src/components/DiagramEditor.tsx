import { useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { exportToSvg } from '@excalidraw/excalidraw'
import { canonicalElements, cleanPreviewSvg, drawingLabelText, plainAppState } from '#/lib/drawing'
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
  const previewRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  const applyResult = async (response: Response) => {
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
    savedCanon.current = canonicalElements(elementsRef.current)
    dirtyRef.current = false
    setSaveState('saved')
    if (previewRef.current) onPreview(previewRef.current)
    return true
  }

  const flushSave = async () => {
    clearTimer()
    if (saveState === 'conflict') return false
    if (!dirtyRef.current) return true
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
      return await applyResult(response)
    } catch {
      dirtyRef.current = true
      setSaveState('error')
      return false
    }
  }
  const flushSaveRef = useRef(flushSave)
  flushSaveRef.current = flushSave

  const schedule = () => {
    if (saveState === 'conflict') return
    dirtyRef.current = true
    setSaveState('saving')
    clearTimer()
    timer.current = setTimeout(() => {
      void flushSaveRef.current()
    }, 800)
  }

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
      savedCanon.current = canonicalElements(elements)
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
      dirtyRef.current = true
    }
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
      <div className="board-canvas">
        {Canvas && initial ? (
          <Canvas
            elements={initial.elements}
            appState={initial.appState}
            viewMode={narrow}
            onScene={(elements, appState) => {
              const next = canonicalElements(elements)
              if (next === canonicalElements(elementsRef.current)) return
              elementsRef.current = elements
              appStateRef.current = plainAppState(appState)
              queuePreview()
              if (next === savedCanon.current) return
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
