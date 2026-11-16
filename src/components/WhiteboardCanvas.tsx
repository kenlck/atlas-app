import { useRef } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { canonicalElements, plainAppState } from '#/lib/drawing'

export function WhiteboardCanvas({
  elements,
  appState,
  viewMode,
  onScene,
}: {
  elements: unknown[]
  appState: Record<string, unknown>
  viewMode: boolean
  onScene: (elements: unknown[], appState: Record<string, unknown>) => void
}) {
  const seen = useRef(false)
  const last = useRef('')
  return (
    <div className="board-frame">
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
          if (import.meta.env.DEV) {
            const sink = window as Window & {
              __atlasScene?: unknown[]
              __atlasEmitScene?: (elements: unknown[]) => void
            }
            sink.__atlasScene = elementsJson
            sink.__atlasEmitScene = (measured) => {
              onScene(JSON.parse(JSON.stringify(measured)) as unknown[], plainAppState(nextState))
            }
          }
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
