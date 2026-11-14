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
import { NewPageMenu } from './NewPageMenu'
import { PageMenu } from './PageMenu'
import { lockBannerText, lockHolderName } from '#/lib/page-lock-message'
import { PageModeBar, saveStatusLabel } from './PageModeBar'

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
  const { createChild, requestDelete, requestLock } = useSpaceOutlet()
  const [deleted, setDeleted] = useState(false)
  const deletedRef = useRef(false)
  const board = page.drawing
  const [title, setTitle] = useState(page.title)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [editing, setEditing] = useState(false)
  const [held, setHeld] = useState<string | null>(null)
  const frozenRef = useRef(false)
  const editingRef = useRef(false)
  editingRef.current = editing
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState
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

  const freeze = (name: string) => {
    frozenRef.current = true
    editingRef.current = false
    dirtyRef.current = false
    clearTimer()
    setHeld(name)
    setEditing(false)
    setSaveState('saved')
  }

  const applyResult = async (response: Response) => {
    if (response.status === 423) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null
      freeze(lockHolderName(body?.error ?? body) ?? 'someone')
      return false
    }
    if (response.status === 404) {
      deletedRef.current = true
      dirtyRef.current = false
      setDeleted(true)
      return false
    }
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
    savedTitle.current = titleRef.current
    dirtyRef.current = false
    setSaveState('saved')
    void routerRef.current.invalidate({
      filter: (match) => match.routeId === '/_app/s/$spaceId',
    })
    return true
  }

  const flushSave = async () => {
    clearTimer()
    if (deletedRef.current || frozenRef.current) return false
    if (saveStateRef.current === 'conflict') return false
    if (!dirtyRef.current) return saveStateRef.current !== 'error'
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
    if (deletedRef.current || frozenRef.current) return
    if (!editingRef.current || saveStateRef.current === 'conflict') return
    dirtyRef.current = true
    setSaveState('saving')
    clearTimer()
    timer.current = setTimeout(() => {
      void flushSaveRef.current()
    }, 800)
  }

  const leaveEdit = () => {
    void (async () => {
      const ok = await flushSaveRef.current()
      if (ok) setEditing(false)
    })()
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
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return
      clearTimer()
      if (frozenRef.current || !dirtyRef.current || saveState === 'conflict') return
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
      <PageModeBar
        breadcrumbs={page.breadcrumbs}
        editing={editing && !held}
        saveLabel={saveStatusLabel(saveState)}
        lockedByName={held ?? page.lockedByName}
        canEdit={held ? false : page.canEdit}
        onEdit={() => {
          if (frozenRef.current || !page.canEdit) return
          setEditing(true)
        }}
        onLeave={leaveEdit}
        menu={
          <>
            <NewPageMenu
              label="Create page"
              className="create-page"
              onChoose={(kind) => createChild(page.id, kind)}
            />
            <PageMenu
              canDelete={page.canDelete}
              canLock={page.canLock}
              locked={Boolean(page.lockedByName)}
              onDelete={() => requestDelete(page.id)}
              onLock={() => requestLock(page.id, !page.lockedByName)}
            />
          </>
        }
      />
      {deleted ? (
        <div className="nf">
          <h1>This page was deleted.</h1>
        </div>
      ) : null}
      {deleted || !held ? null : (
        <div className="banner" role="alert">
          {lockBannerText(held)}
        </div>
      )}
      {deleted || held || saveState !== 'error' ? null : (
        <div className="retry">
          Couldn't save.
          <button type="button" onClick={() => void flushSave()}>
            Retry
          </button>
        </div>
      )}
      {deleted || saveState !== 'conflict' ? null : (
        <div className="retry" role="alert">
          board changed, reload
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {deleted ? null : (
      <>
      <div className="board-head">
        <input
          id="page-title"
          className="title-input"
          aria-label="Title"
          placeholder="Untitled"
          value={title}
          readOnly={!editing || Boolean(held)}
          onChange={(event) => {
            if (frozenRef.current || !editingRef.current) return
            setTitle(event.target.value)
            titleRef.current = event.target.value
            schedule()
          }}
          onBlur={() => {
            if (frozenRef.current || !editingRef.current) return
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
            viewMode={!editing || Boolean(held) || !page.canEdit}
            onScene={(elements, appState) => {
              if (frozenRef.current || !editingRef.current) return
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
      </>
      )}
    </div>
  )
}
