const PREFIX = 'Page is locked by '

function texts(error: unknown, depth = 0): string[] {
  if (depth > 5 || error == null) return []
  if (typeof error === 'string') return [error]
  if (typeof error !== 'object') return []
  const record = error as Record<string, unknown>
  const out: string[] = []
  for (const key of ['message', 'error', 'statusMessage', 'data', 'cause', 'body']) {
    if (key in record) out.push(...texts(record[key], depth + 1))
  }
  return out
}

export function lockHolderName(error: unknown) {
  for (const text of texts(error)) {
    const at = text.indexOf(PREFIX)
    if (at < 0) continue
    const name = text.slice(at + PREFIX.length).trim().split('\n')[0] ?? ''
    return name || 'someone'
  }
  return null
}

export function lockBannerText(name: string) {
  return `${name} locked this page. Your last changes weren't saved.`
}
