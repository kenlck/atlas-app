import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

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

export function EditorToolbar({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

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

  if (!editor) {
    return <div className="tool" />
  }

  const current = styles.find((item) => item.value === styleValue(editor)) ?? styles[0]

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

  return (
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
      <button type="button" className={editor.isActive('bold') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBold().run()}>
        <b>B</b>
      </button>
      <button type="button" className={editor.isActive('italic') ? 'on' : ''} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <i>I</i>
      </button>
      <button type="button" className={editor.isActive('underline') ? 'on' : ''} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <u>U</u>
      </button>
      <button type="button" className={editor.isActive('strike') ? 'on' : ''} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <s>S</s>
      </button>
      <span className="sep" />
      <button type="button" className={editor.isActive('bulletList') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        •≡
      </button>
      <button type="button" className={editor.isActive('orderedList') ? 'on' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1≡
      </button>
      <button type="button" className={editor.isActive('taskList') ? 'on' : ''} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        ☑
      </button>
      <button
        type="button"
        aria-label="Link"
        className={editor.isActive('link') ? 'on' : ''}
        onClick={setLink}
      >
        🔗
      </button>
      <span className="sep" />
      <button type="button" className={editor.isActive('codeBlock') ? 'on' : ''} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        {'{ }'}
      </button>
      <button type="button" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        —
      </button>
    </div>
  )
}
