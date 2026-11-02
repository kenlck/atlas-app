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
  return (
    <div className="board-frame">
      <Excalidraw
        initialData={{
          elements: elements as never,
          appState: appState as never,
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
          if (canonicalElements(elementsJson) === canonicalElements(elements)) return
          onScene(elementsJson, plainAppState(nextState))
        }}
      />
    </div>
  )
}
