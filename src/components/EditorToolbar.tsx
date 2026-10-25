import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { todayIso } from '#/lib/date-label'
import { selectedCellCount, tableHasHeaderRow } from '#/lib/table-state'

const styles = [
  { label: 'Paragraph', value: 'paragraph' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
]

function styleValue(editor: Editor) {
  if (editor.isActive('heading', { level: 1 })) return 'h1'
  if (editor.isActive('heading', { level: 2 })) return 'h2'
  if (editor.isActive('heading', { level: 3 })) return 'h3'
  return 'paragraph'
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.25 6.5h11.5M2.25 10.5h11.5M6.5 2.25v11.5M10.5 2.25v11.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.25 6.5h11.5M5 2v3M11 2v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function toolbarSnapshot(current: Editor) {
  return {
    style: styleValue(current),
    bold: current.isActive('bold'),
    italic: current.isActive('italic'),
    underline: current.isActive('underline'),
    strike: current.isActive('strike'),
    bullet: current.isActive('bulletList'),
    ordered: current.isActive('orderedList'),
    task: current.isActive('taskList'),
    link: current.isActive('link'),
    code: current.isActive('codeBlock'),
    inTable: current.isActive('table'),
    cells: selectedCellCount(current),
    header: tableHasHeaderRow(current),
  }
}

export function EditorToolbar({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(0)
  const inTableRef = useRef(false)
  const watched = useEditorState({
    editor,
    selector: ({ editor: current }) => (current ? toolbarSnapshot(current) : null),
  })
  // useEditorState keeps its first snapshot when the editor is created with
  // content and no later transaction runs. Read the live editor until then.
  const snapshot = watched ?? (editor ? toolbarSnapshot(editor) : null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => {
    if (!editor) return
    const remember = () => {
      const doc = document.querySelector('.doc')
      if (doc instanceof HTMLElement) scrollTop.current = doc.scrollTop
    }
    remember()
    editor.on('selectionUpdate', remember)
    return () => {
      editor.off('selectionUpdate', remember)
    }
  }, [editor])

  const inTable = Boolean(snapshot?.inTable)
  useLayoutEffect(() => {
    const doc = document.querySelector('.doc')
    if (!(doc instanceof HTMLElement)) return
    if (inTableRef.current !== inTable) {
      doc.scrollTop = scrollTop.current
      inTableRef.current = inTable
    }
  }, [inTable])

  if (!editor || !snapshot) {
    return <div className="tool" />
  }

  const current = styles.find((item) => item.value === snapshot.style) ?? styles[0]

  const setStyle = (value: string) => {
    if (value === 'paragraph') editor.chain().focus().setParagraph().run()
    if (value === 'h1') editor.chain().focus().toggleHeading({ level: 1 }).run()
    if (value === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run()
    if (value === 'h3') editor.chain().focus().toggleHeading({ level: 3 }).run()
    setOpen(false)
  }

  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined
    const next = window.prompt('Link URL', previous ?? 'https://')
    if (next === null) return
    if (next === '') {
      editor.chain().focus().unsetLink().run()
      return
    }
    editor.chain().focus().setLink({ href: next }).run()
  }

  const canMerge = snapshot.cells >= 2

  return (
    <>
      <div className={open ? 'tool is-open' : 'tool'} ref={root}>
        <div className="style-wrap">
          <button
            type="button"
            className="sel"
            aria-label="Text style"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {current.label}
            <span>▾</span>
          </button>
          {open ? (
            <div className="menu style-menu" role="listbox">
              {styles.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="option"
                  aria-selected={item.value === current.value}
                  className={item.value === current.value ? 'on' : ''}
                  onClick={() => setStyle(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <span className="sep" />
        <button type="button" className={snapshot.bold ? 'on' : ''} onClick={() => editor.chain().focus().toggleBold().run()}>
          <b>B</b>
        </button>
        <button type="button" className={snapshot.italic ? 'on' : ''} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <i>I</i>
        </button>
        <button type="button" className={snapshot.underline ? 'on' : ''} onClick={() => editor.chain().focus().toggleUnderline().run()}>
          <u>U</u>
        </button>
        <button type="button" className={snapshot.strike ? 'on' : ''} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <s>S</s>
        </button>
        <span className="sep" />
        <button type="button" className={snapshot.bullet ? 'on' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          •≡
        </button>
        <button type="button" className={snapshot.ordered ? 'on' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          1≡
        </button>
        <button type="button" className={snapshot.task ? 'on' : ''} onClick={() => editor.chain().focus().toggleTaskList().run()}>
          ☑
        </button>
        <button
          type="button"
          aria-label="Link"
          className={snapshot.link ? 'on' : ''}
          onClick={setLink}
        >
          🔗
        </button>
        <button
          type="button"
          className={snapshot.inTable ? 'tool-btn on' : 'tool-btn'}
          title="Table"
          aria-label="Table"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          <GridIcon />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="Date"
          aria-label="Date"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertContent({ type: 'dateChip', attrs: { date: todayIso() } })
              .run()
          }
        >
          <CalendarIcon />
        </button>
        <span className="sep" />
        <button type="button" className={snapshot.code ? 'on' : ''} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
          {'{ }'}
        </button>
        <button type="button" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          —
        </button>
      </div>
      {inTable ? (
        <div className="table-tools">
          <button type="button" className="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addRowBefore().run()}>
            Row above
          </button>
          <button type="button" className="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addRowAfter().run()}>
            Row below
          </button>
          <span className="sep" />
          <button type="button" className="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addColumnBefore().run()}>
            Column left
          </button>
          <button type="button" className="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().addColumnAfter().run()}>
            Column right
          </button>
          <span className="sep" />
          <button
            type="button"
            className="ghost"
            disabled={!canMerge}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().mergeCells().run()}
          >
            Merge cells
          </button>
          <button
            type="button"
            className={snapshot.header ? 'ghost on' : 'ghost'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleHeaderRow().run()}
          >
            Header row
          </button>
          <button type="button" className="ghost danger" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().deleteTable().run()}>
            Delete table
          </button>
        </div>
      ) : null}
    </>
  )
}
