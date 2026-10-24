import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { formatDateLabel } from '#/lib/date-label'
import { closeDatePicker, getDatePickerRequest, openDatePicker } from '#/lib/date-picker-store'

export function DateChipView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const date = String(node.attrs.date ?? '')
  const chipRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const chip = chipRef.current
    return () => {
      const existing = getDatePickerRequest()
      if (chip && existing?.chip === chip) closeDatePicker(existing.id)
    }
  }, [])

  const openPicker = () => {
    const chip = chipRef.current
    if (!chip) return
    const existing = getDatePickerRequest()
    if (existing?.chip === chip) {
      closeDatePicker(existing.id)
      return
    }
    openDatePicker({
      date,
      chip,
      pick: (iso) => updateAttributes({ date: iso }),
      remove: () => deleteNode(),
      focusChip: () => chip.focus(),
    })
  }

  return (
    <NodeViewWrapper
      ref={chipRef}
      as="span"
      className={selected ? 'date-chip is-selected' : 'date-chip'}
      data-date={date}
      contentEditable={false}
      style={{ whiteSpace: 'nowrap' }}
      tabIndex={0}
      onClick={openPicker}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openPicker()
        }
      }}
    >
      {formatDateLabel(date)}
    </NodeViewWrapper>
  )
}
