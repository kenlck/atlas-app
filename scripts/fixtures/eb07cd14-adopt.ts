// View-mount adopt from src/components/DiagramView.tsx at
// eb07cd140dbb868719fed3138f3cf606235c9fb4. The page is not in Edit.
// Opening it fetches the drawing, clones a foreign id, and saves.

export const PINNED_ADOPT_SHA = 'eb07cd140dbb868719fed3138f3cf606235c9fb4'

export const PINNED_ADOPT_SNIPPET =
  'const created = await cloneDiagramFn({ data: { pageId, drawingId } })'

type DrawingResponse = {
  ok: boolean
  pageId?: string
  previewSvg?: string | null
}

type AdoptDeps = {
  fetchDrawing: (drawingId: string) => Promise<DrawingResponse>
  cloneDiagram: (pageId: string, drawingId: string) => Promise<{ id: string }>
  saveRepair: (drawingId: string) => void
}

export async function runEb07cd14ViewAdopt(deps: AdoptDeps) {
  const drawingId = 'foreign-drawing'
  const pageId = 'dest-page'
  const response = await deps.fetchDrawing(drawingId)
  if (!response.ok) return
  if (response.pageId !== pageId) {
    const created = await deps.cloneDiagram(pageId, drawingId)
    deps.saveRepair(created.id)
  }
}
