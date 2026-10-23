import type { Editor } from '@tiptap/react'

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
  if (!editor) {
    return <div className="tool" />
  }

  const setStyle = (value: string) => {
    if (value === 'paragraph') editor.chain().focus().setParagraph().run()
    if (value === 'h1') editor.chain().focus().toggleHeading({ level: 1 }).run()
    if (value === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run()
    if (value === 'h3') editor.chain().focus().toggleHeading({ level: 3 }).run()
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
    <div className="tool">
      <select
        className="sel"
        value={styleValue(editor)}
        onChange={(event) => setStyle(event.target.value)}
        aria-label="Text style"
      >
        {styles.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
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
      <button type="button" className={editor.isActive('link') ? 'on' : ''} onClick={setLink}>
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
