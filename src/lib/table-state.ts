import type { Editor } from '@tiptap/react'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { CellSelection } from '@tiptap/pm/tables'

function tableAround(editor: Editor): ProseNode | null {
  const selection = editor.state.selection
  const $pos = selection instanceof CellSelection ? selection.$anchorCell : selection.$from
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.type.name === 'table') return node
  }
  return null
}

export function selectedCellCount(editor: Editor) {
  const selection = editor.state.selection
  if (!(selection instanceof CellSelection)) return 0
  return selection.ranges.length
}

export function tableHasHeaderRow(editor: Editor) {
  const table = tableAround(editor)
  const row = table?.firstChild
  if (!row || row.childCount === 0) return false
  let header = true
  row.forEach((cell) => {
    if (cell.type.name !== 'tableHeader') header = false
  })
  return header
}
