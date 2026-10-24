import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { CellSelection } from '@tiptap/pm/tables'

function cursorCellRange(state: EditorState) {
  const selection = state.selection
  if (selection instanceof CellSelection) {
    const node = selection.$headCell.nodeAfter
    if (!node) return null
    const pos = selection.$headCell.pos
    return { from: pos, to: pos + node.nodeSize }
  }
  const $from = selection.$from
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const role = $from.node(depth).type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') {
      return { from: $from.before(depth), to: $from.after(depth) }
    }
  }
  return null
}

export const TableCursor = Extension.create({
  name: 'tableCursor',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('tableCursor'),
        props: {
          decorations(state) {
            const range = cursorCellRange(state)
            if (!range) return null
            return DecorationSet.create(state.doc, [
              Decoration.node(range.from, range.to, { class: 'cell-cursor' }),
            ])
          },
        },
      }),
    ]
  },
})
