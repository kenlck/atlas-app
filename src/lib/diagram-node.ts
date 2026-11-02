import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { DiagramView } from '#/components/DiagramView'

export function createDiagramExtension(pageId: string) {
  return Node.create({
    name: 'diagram',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,

    addStorage() {
      return { pageId }
    },

    addAttributes() {
      return {
        drawingId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-drawing-id'),
          renderHTML: (attributes) => {
            const id = attributes.drawingId
            if (typeof id !== 'string' || !id) return {}
            return { 'data-drawing-id': id }
          },
        },
      }
    },

    parseHTML() {
      return [
        {
          tag: 'figure[data-drawing-id]',
          getAttrs: (element) => {
            const id = element.getAttribute('data-drawing-id')
            if (!id) return false
            return { drawingId: id }
          },
        },
      ]
    },

    renderHTML({ HTMLAttributes }) {
      return [
        'figure',
        mergeAttributes(HTMLAttributes, { class: 'diagram-block' }),
      ]
    },

    addNodeView() {
      return ReactNodeViewRenderer(DiagramView, {
        stopEvent: ({ event }) => {
          const target = event.target
          if (!(target instanceof Element)) return false
          return Boolean(target.closest('.diagram-block, .diagram-screen'))
        },
      })
    },
  })
}
