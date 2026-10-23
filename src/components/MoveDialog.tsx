import type { TreeNode } from '#/lib/pages'

function flatten(nodes: TreeNode[], prefix = ''): Array<{ id: string; label: string }> {
  return nodes.flatMap((node) => [
    { id: node.id, label: prefix + node.title },
    ...flatten(node.children, `${prefix + node.title} / `),
  ])
}

function withoutBranch(nodes: TreeNode[], blocked: string): TreeNode[] {
  return nodes
    .filter((node) => node.id !== blocked)
    .map((node) => ({ ...node, children: withoutBranch(node.children, blocked) }))
}

export function MoveDialog({
  tree,
  pageId,
  onCancel,
  onMove,
}: {
  tree: TreeNode[]
  pageId: string
  onCancel: () => void
  onMove: (parentId: string | null) => void
}) {
  const options = flatten(withoutBranch(tree, pageId))
  return (
    <div className="auth" style={{ position: 'fixed', inset: 0, background: 'transparent', zIndex: 40 }}>
      <div className="card">
        <h1>Move page</h1>
        <div className="sub">Choose a new parent.</div>
        <button className="it" type="button" onClick={() => onMove(null)}>
          Top level
        </button>
        {options.map((option) => (
          <button key={option.id} className="it" type="button" onClick={() => onMove(option.id)}>
            {option.label}
          </button>
        ))}
        <div className="foot-auth">
          <button className="ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
