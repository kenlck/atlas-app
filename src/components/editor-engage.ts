const engageEvents = [
  'pointerdown',
  'keydown',
  'paste',
  'drop',
  'compositionstart',
] as const

// Capture on the editor container runs before Excalidraw handles the event.
// A keydown whose target is outside this node never arrives, so an unfocused
// canvas is not treated as in use.
export function listenForEngage(node: HTMLElement, engage: () => void) {
  const opts: AddEventListenerOptions = { capture: true }
  for (const type of engageEvents) node.addEventListener(type, engage, opts)
  return () => {
    for (const type of engageEvents) node.removeEventListener(type, engage, opts)
  }
}
