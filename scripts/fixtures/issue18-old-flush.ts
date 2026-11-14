// Checked-in copy of the flush and New page path at
// fb2cfaa366ffb595b6a9e11bab8c1409158ca6f4.
// flushEditor had no timeout. PageEditor.flushSave swallowed a failed save.
// AppFrame.create awaited that flush and then created the page.

let flush = async () => {}

export function registerOldEditorFlush(fn: () => Promise<void>) {
  flush = fn
  return () => {
    if (flush === fn) flush = async () => {}
  }
}

export function oldFlushEditor() {
  return flush()
}

export async function oldFlushSave(run: () => Promise<void>) {
  try {
    await run()
  } catch {
    // PageEditor.flushSave at fb2cfaa caught the rejection and did not rethrow.
  }
}

export async function oldCreatePage(create: () => Promise<void>) {
  await oldFlushEditor()
  await create()
}
