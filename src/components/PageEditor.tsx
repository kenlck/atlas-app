import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Underline from '@tiptap/extension-underline'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Json } from '#/lib/body-text'
import type { PageView } from '#/lib/pages'
import { registerEditorFlush } from '#/lib/editor-flush'
import { relativeTime } from '#/lib/relative-time'
import { savePageFn } from '#/server/fns'
import { EditorToolbar } from './EditorToolbar'
import { createMentionExtension } from './MentionExtension'

type SaveState = 'saved' | 'saving' | 'error'

const spaceRoute = getRouteApi('/_app/s/$spaceId')

function draftKey(pageId: string) {
  return `atlas-draft:${pageId}`
}

function readDraft(pageId: string): { title: string; body: Json } | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(draftKey(pageId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { title?: unknown; body?: unknown }
    if (!parsed || typeof parsed.title !== 'string' || parsed.body == null) {
      return null
    }
    return { title: parsed.title, body: parsed.body as Json }
  } catch {
    return null
  }
}

function writeDraft(pageId: string, title: string, body: Json) {
  try {
    sessionStorage.setItem(draftKey(pageId), JSON.stringify({ title, body }))
  } catch {
    // The server flush still runs when storage is full.
  }
}

function clearDraft(pageId: string) {
  try {
    sessionStorage.removeItem(draftKey(pageId))
  } catch {
    // Ignore storage failures.
  }
}

function flushKeepalive(payload: {
  pageId: string
  title: string
  body: Json
}) {
  const body = JSON.stringify(payload)
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/pages/save', false)
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.send(body)
    if (xhr.status >= 200 && xhr.status < 300) return
  } catch {
    // Page dismissal can reject a synchronous request.
  }
  const blob = new Blob([body], { type: 'application/json' })
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
  ) {
    if (navigator.sendBeacon('/api/pages/save', blob)) return
  }
  void fetch('/api/pages/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    credentials: 'include',
    keepalive: true,
  })
}

export function PageEditor({ page }: { page: PageView }) {
  const router = useRouter()
  const draftRef = useRef(readDraft(page.id))
  const draft = draftRef.current
  const [title, setTitle] = useState(page.title)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const titleRef = useRef(page.title)
  const savedTitle = useRef(page.title)
  const bodyRef = useRef(draft?.body ?? page.body)
  const dirtyRef = useRef(draft != null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pageIdRef = useRef(page.id)
  const peopleRef = useRef(page.people)
  peopleRef.current = page.people
  const spaceData = spaceRoute.useLoaderData()
  const mentions = useMemo(
    () =>
      createMentionExtension({
        spaceId: page.spaceId,
        getPeople: () => peopleRef.current,
      }),
    [page.spaceId],
  )

  const persist = async () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirtyRef.current) return
    dirtyRef.current = false
    setSaveState('saving')
    try {
      await savePageFn({
        data: {
          pageId: pageIdRef.current,
          title: titleRef.current,
          body: bodyRef.current as Json,
        },
      })
      setSaveState('saved')
      clearDraft(pageIdRef.current)
      if (savedTitle.current !== titleRef.current) {
        savedTitle.current = titleRef.current
        void router.invalidate({
          filter: (match) => match.routeId === '/_app/s/$spaceId',
        })
      }
    } catch {
      dirtyRef.current = true
      setSaveState('error')
    }
  }
  const persistRef = useRef(persist)
  persistRef.current = persist

  const schedule = () => {
    dirtyRef.current = true
    writeDraft(pageIdRef.current, titleRef.current, bodyRef.current as Json)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void persistRef.current()
    }, 800)
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing' }),
      mentions.extension,
    ],
    content: (draft?.body ?? page.body) as object,
    editorProps: {
      attributes: { class: 'doc-editor' },
    },
    onUpdate: ({ editor: instance }) => {
      bodyRef.current = instance.getJSON() as Json
      schedule()
    },
  })

  useEffect(() => registerEditorFlush(() => persistRef.current()), [])

  useEffect(() => {
    const saved = draftRef.current
    if (saved?.title && saved.title !== page.title) {
      titleRef.current = saved.title
      setTitle(saved.title)
    }
    if (!dirtyRef.current) return
    void persistRef.current()
  }, [page.title])

  useEffect(() => {
    mentions.setOnRefresh(() => {
      if (!editor) return
      mentions.sync(editor.view.dom)
    })
    return () => mentions.setOnRefresh(null)
  }, [mentions, editor])

  const peopleToken = page.people
    .map((person) => `${person.id}:${person.member ? 1 : 0}`)
    .join('|')

  useEffect(() => {
    mentions.clear()
    if (!editor) return
    mentions.sync(editor.view.dom)
  }, [mentions, editor, spaceData, peopleToken])

  useEffect(() => {
    pageIdRef.current = page.id
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (dirtyRef.current) {
        flushKeepalive({
          pageId: pageIdRef.current,
          title: titleRef.current,
          body: bodyRef.current as Json,
        })
      }
      void persistRef.current()
    }
  }, [page.id])

  useEffect(() => {
    const onHide = () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (!dirtyRef.current) return
      dirtyRef.current = false
      flushKeepalive({
        pageId: pageIdRef.current,
        title: titleRef.current,
        body: bodyRef.current as Json,
      })
    }
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
    }
  }, [])

  return (
    <>
      <div className="top">
        {page.breadcrumbs.map((crumb, index) => (
          <span key={crumb.id}>
            {index > 0 ? <span> / </span> : null}
            {index === page.breadcrumbs.length - 1 ? (
              <b>{crumb.title}</b>
            ) : (
              crumb.title
            )}
          </span>
        ))}
        <div className="r">
          <span className="save">
            {saveState === 'saving'
              ? 'Saving'
              : saveState === 'saved'
                ? 'Saved'
                : ''}
          </span>
        </div>
      </div>
      <EditorToolbar editor={editor} />
      {saveState === 'error' ? (
        <div className="retry">
          Couldn't save.
          <button type="button" onClick={() => void persist()}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="doc">
        <div className="col">
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
            onBlur={(event) => {
              const next = event.currentTarget.value
              titleRef.current = next
              setTitle(next)
              if (next !== savedTitle.current) dirtyRef.current = true
              void persistRef.current()
            }}
          />
          <div className="meta">
            Edited by {page.updatedByName} · {relativeTime(page.updatedAt)}
          </div>
          <EditorContent editor={editor} />
        </div>
      </div>
    </>
  )
}
