import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { canonicalElements } from '#/lib/drawing'
import {
  browserDrawingSaveTransport,
  deliverDrawingSave,
} from '#/lib/drawing-keepalive'
import { relativeTime } from '#/lib/relative-time'
import type { PageView } from '#/lib/pages'
import { useSpaceOutlet } from './AppFrame'

type SaveState = 'saved' | 'saving' | 'error' | 'conflict'

type CanvasProps = {
  elements: unknown[]
  appState: Record<string, unknown>
  viewMode: boolean
  onScene: (elements: unknown[], appState: Record<string, unknown>) => void
}

const SAVE_URL = '/api/drawings'

export function Whiteboard({ page }: { page: PageView }) {
  const router = useRouter()
  const { createChild } = useSpaceOutlet()
  const board = page.drawing
  const [title, setTitle] = useState(page.title)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [narrow, setNarrow] = useState(false)
  const [Canvas, setCanvas] = useState<ComponentType<CanvasProps> | null>(null)
  const titleRef = useRef(page.title)
  const savedTitle = useRef(page.title)
  const elementsRef = useRef<unknown[]>(board?.elements ?? [])
  const appStateRef = useRef<Record<string, unknown>>(board?.appState ?? {})
  const versionRef = useRef(board?.version ?? 1)
  const savedCanon = useRef(canonicalElements(board?.elements ?? []))
  const dirtyRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pageIdRef = useRef(page.id)

  const routerRef = useRef(router)
  routerRef.current = router

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const payload = (via: 'autosave' | 'flush') => ({
    pageId: pageIdRef.current,
    version: versionRef.current,
    title: titleRef.current,
    elements: elementsRef.current,
    appState: appStateRef.current,
    files: {},
    via,
  })

  const applyResult = async (response: Response) => {
    if (response.status === 409) {
      dirtyRef.current = false
      setSaveState('conflict')
      return
    }
    if (!response.ok) {
      dirtyRef.current = true
      setSaveState('error')
      return
    }
    const body = (await response.json()) as { version?: number }
    if (typeof body.version === 'number') versionRef.current = body.version
    savedCanon.current = canonicalElements(elementsRef.current)
    savedTitle.current = titleRef.current
    dirtyRef.current = false
    setSaveState('saved')
    void routerRef.current.invalidate({
      filter: (match) => match.routeId === '/_app/s/$spaceId',
    })
  }

  const flushSave = async () => {
    clearTimer()
    if (!dirtyRef.current || saveState === 'conflict') return
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
      await applyResult(response)
    } catch {
      dirtyRef.current = true
      setSaveState('error')
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
    let cancelled = false
    void import('./WhiteboardCanvas').then((mod) => {
      if (!cancelled) setCanvas(() => mod.WhiteboardCanvas)
    })
    return () => {
      cancelled = true
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

  if (!board) return null

  return (
    <div className="board">
      <div className="top">
        <div className="crumbs">
          {page.breadcrumbs.map((crumb, index) => (
            <span key={crumb.id}>
              {index > 0 ? <span> / </span> : null}
              {index === page.breadcrumbs.length - 1 ? <b>{crumb.title}</b> : crumb.title}
            </span>
          ))}
        </div>
        <div className="r">
          <button type="button" className="create-page" onClick={() => createChild(page.id)}>
            Create page
          </button>
          <span className="save">
            {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : ''}
          </span>
        </div>
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
      <div className="board-head">
        <input
          id="page-title"
          className="title-input"
          aria-label="Title"
          placeholder="Untitled"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value)
            titleRef.current = event.target.value
            schedule()
          }}
          onBlur={() => {
            if (titleRef.current !== savedTitle.current) {
              dirtyRef.current = true
              void flushSaveRef.current()
            }
          }}
        />
        <div className="meta">
          Edited by {page.updatedByName} · {relativeTime(page.updatedAt)}
        </div>
      </div>
      <div className="board-canvas">
        {Canvas ? (
          <Canvas
            elements={board.elements}
            appState={board.appState}
            viewMode={narrow}
            onScene={(elements, appState) => {
              const next = canonicalElements(elements)
              // Excalidraw repeats the same scene while the pointer moves.
              // A failed save must stay on the Retry banner, so ignore repeats.
              if (next === canonicalElements(elementsRef.current)) return
              elementsRef.current = elements
              appStateRef.current = appState
              if (next === savedCanon.current) return
              schedule()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
