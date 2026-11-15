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

function statusOf(error: unknown, depth = 0): number | null {
  if (depth > 5 || error == null || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  if (record.status === 423 || record.statusCode === 423) return 423
  for (const key of ['cause', 'data', 'body', 'error']) {
    if (key in record && record[key] !== error) {
      const nested = statusOf(record[key], depth + 1)
      if (nested === 423) return 423
    }
  }
  return null
}

export function moveFailureToast(error: unknown) {
  const name = lockHolderName(error)
  if (name || statusOf(error) === 423) {
    return name ? `${PREFIX}${name}` : 'Page is locked.'
  }
  return "You can't move this page."
}
