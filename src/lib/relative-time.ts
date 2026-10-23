export function relativeTime(iso: string, now = new Date()) {
  const then = new Date(iso)
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? 'A'
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : (parts[0]?.[1] ?? '')
  return (first + last).toUpperCase()
}
