import { useEffect, useRef } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { canonicalElements, plainAppState } from '#/lib/drawing'
import { listenForEngage } from './editor-engage'

export function WhiteboardCanvas({
  elements,
  appState,
  viewMode,
  onScene,
  onEngage,
}: {
  elements: unknown[]
  appState: Record<string, unknown>
  viewMode: boolean
  onScene: (elements: unknown[], appState: Record<string, unknown>) => void
  onEngage?: () => void
}) {
  const seen = useRef(false)
  const last = useRef('')
  const frame = useRef<HTMLDivElement>(null)
  const engageRef = useRef(onEngage)
  engageRef.current = onEngage
  useEffect(() => {
    const node = frame.current
    if (!node) return
    return listenForEngage(node, () => engageRef.current?.())
  }, [])
  return (
    <div className="board-frame" ref={frame}>
      <Excalidraw
        initialData={{
          elements: elements as never,
          appState: appState,
        }}
        viewModeEnabled={viewMode}
        UIOptions={{
          tools: { image: false },
          canvasActions: {
            export: false,
            loadScene: false,
            saveAsImage: false,
            saveToActiveFile: false,
          },
        }}
        onChange={(nextElements, nextState) => {
          const elementsJson = JSON.parse(JSON.stringify(nextElements)) as unknown[]
          const next = canonicalElements(elementsJson)
          if (!seen.current) {
            seen.current = true
            last.current = next
            onScene(elementsJson, plainAppState(nextState))
            return
          }
          if (next === last.current) return
          last.current = next
          onScene(elementsJson, plainAppState(nextState))
        }}
      />
    </div>
  )
}
