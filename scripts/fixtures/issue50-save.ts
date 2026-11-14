// Stand-in: a fresh save already succeeds on 34a6d032. Rejecting every save
// makes the check stricter than that commit.

export function rejectEverySave(source: string) {
  const marker = 'export async function savePage('
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('savePage missing')
  const body = source.indexOf(') {\n', start)
  if (body < 0) throw new Error('savePage body missing')
  const brace = body + 2
  return `${source.slice(0, brace + 1)}\n  throw new HttpError(409, 'Conflict')\n${source.slice(brace + 1)}`
}
