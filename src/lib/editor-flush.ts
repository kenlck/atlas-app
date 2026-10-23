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
