import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { cloneDiagramFn } from '#/server/fns'

function isCancelled(flag: { current: boolean }) {
  return flag.current
}

type EditorProps = {
  drawingId: string
  pageId: string
  onClose: () => void
  onPreview: (svg: string | null) => void
}

function pageIsEditing(editor: NodeViewProps['editor']) {
  return (editor.storage as { diagram?: { editing?: boolean } }).diagram?.editing === true
}

function laterCopy(
  editor: NodeViewProps['editor'],
  drawingId: string,
  pos: number,
) {
  let index = 0
  let mine = 0
  editor.state.doc.descendants((node, nodePos) => {
    if (node.type.name !== 'diagram' || node.attrs.drawingId !== drawingId) return
    if (nodePos === pos) mine = index
    index += 1
  })
  return index > 1 && mine > 0
}

export function DiagramView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const drawingId = String(node.attrs.drawingId ?? '')
  const pageId = String(
    (editor.storage as { diagram?: { pageId?: string } }).diagram?.pageId ?? '',
  )
  const [preview, setPreview] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [open, setOpen] = useState(false)
  const [Editor, setEditor] = useState<ComponentType<EditorProps> | null>(null)
  const getPosRef = useRef(getPos)
  const updateRef = useRef(updateAttributes)
  getPosRef.current = getPos
  updateRef.current = updateAttributes
  const [pageEditing, setPageEditing] = useState(() => pageIsEditing(editor))

  useEffect(() => {
    const sync = () => {
      const next = pageIsEditing(editor)
      setPageEditing((current) => (current === next ? current : next))
    }
    editor.on('transaction', sync)
    return () => {
      editor.off('transaction', sync)
    }
  }, [editor])

  useEffect(() => {
    if (!pageEditing) return
    const cancel = { current: false }
    setPhase('loading')
    setPreview(null)
    const run = async () => {
      if (!drawingId || !pageId) {
        if (!cancel.current) setPhase('unavailable')
        return
      }
      const response = await fetch(
        `/api/drawings?drawingId=${encodeURIComponent(drawingId)}`,
        { credentials: 'include' },
      )
      if (cancel.current) return
      if (!response.ok) {
        setPhase('unavailable')
        return
      }
      const data = (await response.json()) as {
        pageId?: string
        previewSvg?: string | null
      }
      const readPos = getPosRef.current
      const pos = typeof readPos === 'function' ? readPos() : null
      const extra = pos != null && laterCopy(editor, drawingId, pos)
      if (data.pageId !== pageId || extra) {
        try {
          const created = await cloneDiagramFn({ data: { pageId, drawingId } })
          if (isCancelled(cancel)) return
          const readPosNow = getPosRef.current
          const at = typeof readPosNow === 'function' ? readPosNow() : pos
          if (typeof at === 'number') {
            editor.commands.command(({ tr }) => {
              const current = tr.doc.nodeAt(at)
              if (!current || current.type.name !== 'diagram') return false
              tr.setNodeMarkup(at, undefined, {
                ...current.attrs,
                drawingId: created.id,
              })
              return true
            })
          } else {
            updateRef.current({ drawingId: created.id })
          }
        } catch {
          if (!isCancelled(cancel)) setPhase('unavailable')
        }
        return
      }
      const svg = typeof data.previewSvg === 'string' ? data.previewSvg : ''
      setPreview(svg || null)
      setPhase('ready')
    }
    void run()
    return () => {
      cancel.current = true
    }
  }, [drawingId, pageId, editor, pageEditing])

  const openEditor = () => {
    if (phase !== 'ready') return
    setOpen(true)
    if (Editor) return
    void import('./DiagramEditor').then((mod) => {
      setEditor(() => mod.DiagramEditor)
    })
  }

  const src = preview
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`
    : ''

  const screen =
    open && typeof document !== 'undefined'
      ? createPortal(
          Editor ? (
            <Editor
              drawingId={drawingId}
              pageId={pageId}
              onClose={() => setOpen(false)}
              onPreview={(svg) => setPreview(svg || null)}
            />
          ) : (
            <div className="diagram-screen" role="dialog" aria-label="Drawing">
              <div className="diagram-spin-wrap">
                <div className="diagram-spin" role="status" aria-label="Loading drawing" />
              </div>
            </div>
          ),
          document.body,
        )
      : null

  return (
    <NodeViewWrapper
      className="diagram-block"
      data-drawing-id={drawingId}
      contentEditable={false}
      onClick={openEditor}
    >
      {preview ? (
        <img src={src} alt="Drawing" />
      ) : phase === 'unavailable' ? (
        <p className="diagram-empty">Drawing unavailable</p>
      ) : phase === 'loading' ? (
        <p className="diagram-empty"> </p>
      ) : (
        <p className="diagram-empty">Empty drawing</p>
      )}
      <button
        type="button"
        className="diagram-edit"
        onClick={(event) => {
          event.stopPropagation()
          openEditor()
        }}
      >
        Edit
      </button>
      {screen}
    </NodeViewWrapper>
  )
}
