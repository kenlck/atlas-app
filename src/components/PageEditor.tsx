import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Underline from '@tiptap/extension-underline'
import { useRouter } from '@tanstack/react-router'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import type { Json } from '#/lib/body-text'
import type { PageView } from '#/lib/pages'
import { relativeTime } from '#/lib/relative-time'
import { savePageFn } from '#/server/fns'
import { EditorToolbar } from './EditorToolbar'
import { createMentionExtension } from './MentionExtension'

type SaveState = 'saved' | 'saving' | 'error'

function flushKeepalive(payload: {
  pageId: string
  title: string
  body: Json
}) {
  const body = JSON.stringify(payload)
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
  const [title, setTitle] = useState(page.title)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const titleRef = useRef(title)
  const savedTitle = useRef(page.title)
  const bodyRef = useRef(page.body)
  const dirtyRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pageIdRef = useRef(page.id)
  const peopleRef = useRef(page.people)
  peopleRef.current = page.people

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
      createMentionExtension({
        spaceId: page.spaceId,
        getPeople: () => peopleRef.current,
      }),
    ],
    content: page.body as object,
    editorProps: {
      attributes: { class: 'doc-editor' },
    },
    onUpdate: ({ editor: instance }) => {
      bodyRef.current = instance.getJSON() as Json
      schedule()
    },
  })

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
