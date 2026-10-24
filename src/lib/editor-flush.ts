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

  return {
    update(snapshot: EditorSnapshot) {
      pending = snapshot
    },
    flush() {
      const run = tail.then(async () => {
        while (pending) {
          const snapshot = pending
          pending = null
          try {
            await save(snapshot)
          } catch (error) {
            if (!pending) pending = snapshot
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
