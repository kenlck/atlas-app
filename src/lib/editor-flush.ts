let flush = async () => {}

export function registerEditorFlush(fn: () => Promise<void>) {
  flush = fn
  return () => {
    if (flush === fn) flush = async () => {}
  }
}

export function flushEditor() {
  return flush()
}

export type EditorSnapshot = {
  pageId: string
  title: string
  body: unknown
}

export function createEditorSave(
  save: (snapshot: EditorSnapshot) => Promise<void>,
) {
  let tail: Promise<void> = Promise.resolve()
  let pending: EditorSnapshot | null = null
  const latestPending = () => pending

  return {
    update(snapshot: EditorSnapshot) {
      pending = snapshot
    },
    flush() {
      const run = tail.then(async () => {
        while (latestPending()) {
          const snapshot = latestPending()
          if (!snapshot) break
          pending = null
          try {
            await save(snapshot)
          } catch (error) {
            if (latestPending() == null) pending = snapshot
            throw error
          }
        }
      })
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }
}
