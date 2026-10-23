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

type SaveState = 'saved' | 'saving' | 'error'

export function PageEditor({ page }: { page: PageView }) {
  const router = useRouter()
  const [title, setTitle] = useState(page.title)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const titleRef = useRef(title)
  const savedTitle = useRef(page.title)
  const bodyRef = useRef(page.body)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const persist = async () => {
    setSaveState('saving')
    try {
      await savePageFn({
        data: {
          pageId: page.id,
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
      setSaveState('error')
    }
  }

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void persist()
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
    setTitle(page.title)
    titleRef.current = page.title
    bodyRef.current = page.body
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(page.body)) {
      editor.commands.setContent(page.body as object)
    }
  }, [page.id])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return (
    <>
      <div className="top">
        {page.breadcrumbs.map((crumb, index) => (
          <span key={crumb.id}>
            {index > 0 ? <span> / </span> : null}
            {index === page.breadcrumbs.length - 1 ? <b>{crumb.title}</b> : crumb.title}
          </span>
        ))}
        <div className="r">
          <span className="save">{saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : ''}</span>
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
          <label className="lab title-lab" htmlFor="page-title">
            Title
          </label>
          <input
            id="page-title"
            className="title-input"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value)
              titleRef.current = event.target.value
              schedule()
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
