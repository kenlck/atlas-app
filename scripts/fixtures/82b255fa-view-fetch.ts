// View fetch skip from src/components/DiagramView.tsx at
// 82b255fad790878495338a3787a09285b2acc741. While the page is in View the
// effect returns before the drawings request, so the block stays on the
// loading placeholder and never paints an image or svg.

export const PINNED_SKIP_SHA = '82b255fad790878495338a3787a09285b2acc741'

export const PINNED_SKIP_SNIPPET = 'if (!pageEditing) return'

type DrawingResponse = {
  previewSvg?: string | null
}

type SkipDeps = {
  fetchDrawing: () => Promise<DrawingResponse>
}

export async function run82b255faViewPreview(editing: boolean, deps: SkipDeps) {
  if (!editing) return { rendered: false }
  const data = await deps.fetchDrawing()
  const svg = typeof data.previewSvg === 'string' ? data.previewSvg : ''
  const rendered = /^<svg\b/i.test(svg) || svg.startsWith('data:image/')
  return { rendered }
}
