import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Underline from '@tiptap/extension-underline'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Json } from '#/lib/body-text'
import type { PageView } from '#/lib/pages'
import { createEditorSave, registerEditorFlush } from '#/lib/editor-flush'
import {
  browserPageSaveTransport,
  deliverPageSave,
} from '#/lib/page-save-keepalive'
import { relativeTime } from '#/lib/relative-time'
import { savePageFn } from '#/server/fns'
import { DateChip } from '#/lib/date-chip'
import { TableCursor } from '#/lib/table-cursor'
import { useSpaceOutlet } from './AppFrame'
import { DatePickerHost } from './DatePicker'
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
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as { title?: unknown; body?: unknown }
    if (typeof record.title !== 'string' || record.body == null) return null
    return { title: record.title, body: record.body as Json }
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

export function PageEditor({ page }: { page: PageView }) {
  const router = useRouter()
  const { createChild } = useSpaceOutlet()
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

  const routerRef = useRef(router)
  routerRef.current = router
  const queueRef = useRef(
    createEditorSave(async (snapshot) => {
      await savePageFn({
        data: {
          pageId: snapshot.pageId,
          title: snapshot.title,
          body: snapshot.body as Json,
        },
      })
      clearDraft(snapshot.pageId)
      if (savedTitle.current !== snapshot.title) {
        savedTitle.current = snapshot.title
        void routerRef.current.invalidate({
          filter: (match) => match.routeId === '/_app/s/$spaceId',
        })
      }
    }),
  )

  const flushSave = async () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (dirtyRef.current) {
      queueRef.current.update({
        pageId: pageIdRef.current,
        title: titleRef.current,
        body: bodyRef.current,
      })
      dirtyRef.current = false
      setSaveState('saving')
    }
    try {
      await queueRef.current.flush()
      setSaveState((state) => (state === 'error' ? state : 'saved'))
    } catch {
      dirtyRef.current = true
      setSaveState('error')
    }
  }
  const flushSaveRef = useRef(flushSave)
  flushSaveRef.current = flushSave

  const schedule = () => {
    dirtyRef.current = true
    writeDraft(pageIdRef.current, titleRef.current, bodyRef.current)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void flushSaveRef.current()
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
      Table.configure({
        resizable: true,
        handleWidth: 4,
        cellMinWidth: 80,
        lastColumnResizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      DateChip,
      TableCursor,
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

  useEffect(() => registerEditorFlush(() => flushSaveRef.current()), [])

  useEffect(() => {
    const saved = draftRef.current
    if (saved?.title && saved.title !== page.title) {
      titleRef.current = saved.title
      setTitle(saved.title)
    }
    if (!dirtyRef.current) return
    void flushSaveRef.current()
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
      void flushSaveRef.current()
    }
  }, [page.id])

  useEffect(() => {
    const onHide = () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (!dirtyRef.current) {
        void flushSaveRef.current()
        return
      }
      const snapshot = {
        pageId: pageIdRef.current,
        title: titleRef.current,
        body: bodyRef.current,
      }
      queueRef.current.update(snapshot)
      dirtyRef.current = false
      const delivered = deliverPageSave(snapshot, browserPageSaveTransport())
      if (delivered === 'sync') clearDraft(snapshot.pageId)
      void flushSaveRef.current()
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
        <div className="crumbs">
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
        </div>
        <div className="r">
          <button
            type="button"
            className="create-page"
            onClick={() => createChild(page.id)}
          >
            Create page
          </button>
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
      <DatePickerHost />
      {saveState === 'error' ? (
        <div className="retry">
          Couldn't save.
          <button type="button" onClick={() => void flushSave()}>
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
              void flushSaveRef.current()
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
