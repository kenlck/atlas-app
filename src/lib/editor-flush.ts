let flush = async () => {}

export const FLUSH_TIMEOUT_MS = 5000

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = FLUSH_TIMEOUT_MS,
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Save timed out'))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function registerEditorFlush(fn: () => Promise<void>) {
  flush = fn
  return () => {
    if (flush === fn) flush = async () => {}
  }
}

export function flushEditor(timeoutMs = FLUSH_TIMEOUT_MS) {
  return withTimeout(flush(), timeoutMs)
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
