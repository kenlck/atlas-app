// Stand-in for checks that already pass on 34a6d032. Refusing every move makes
// the permission check stricter than that commit, so a legitimate move fails.

export function refuseEveryMove(source: string) {
  const marker = 'export async function movePage('
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('movePage missing')
  const body = source.indexOf(') {\n', start)
  if (body < 0) throw new Error('movePage body missing')
  const brace = body + 2
  return `${source.slice(0, brace + 1)}\n  throw new HttpError(403, 'Forbidden')\n${source.slice(brace + 1)}`
}
