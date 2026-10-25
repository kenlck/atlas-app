export type DatePickerRequest = {
  id: number
  date: string
  chip: HTMLElement
  pick: (iso: string) => void
  remove: () => void
  focusChip: () => void
}

let request: DatePickerRequest | null = null
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function openDatePicker(input: Omit<DatePickerRequest, 'id'>) {
  request = { ...input, id: nextId }
  nextId += 1
  emit()
}

export function closeDatePicker(id?: number) {
  if (id !== undefined && request?.id !== id) return
  if (!request) return
  request = null
  emit()
}

export function getDatePickerRequest() {
  return request
}

export function subscribeDatePicker(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
