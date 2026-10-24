import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { DateChipView } from '#/components/DateChipView'
import { dateAttribute, formatDateLabel } from '#/lib/date-label'

export const DateChip = Node.create({
  name: 'dateChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      date: {
        default: null,
        parseHTML: (element) => dateAttribute(element.getAttribute('data-date')),
        renderHTML: (attributes) => {
          const date = dateAttribute(attributes.date)
          if (!date) return {}
          return { 'data-date': date }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-date]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const date = dateAttribute(node.attrs.date)
    return [
      'span',
      mergeAttributes(HTMLAttributes, date ? { 'data-date': date } : {}, {
        class: 'date-chip',
      }),
      formatDateLabel(date ?? ''),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(DateChipView, {
      stopEvent: ({ event }) => {
        const target = event.target
        if (!(target instanceof Element)) return false
        return Boolean(target.closest('.date-chip, .date-picker'))
      },
    })
  },
})
