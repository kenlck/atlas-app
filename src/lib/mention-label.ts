export type MentionPerson = {
  id: string
  name: string
  member: boolean
}

export type MentionCandidate = {
  id: string
  name: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function looksLikeEmail(value: string) {
  return EMAIL_RE.test(value.trim())
}

export function mentionPerson(
  id: string,
  people: MentionPerson[],
  listed: Iterable<{ id: string; name: string }>,
): MentionPerson | null {
  const known = people.find((person) => person.id === id)
  if (known) return known
  for (const row of listed) {
    if (row.id !== id) continue
    return { id: row.id, name: row.name, member: true }
  }
  return null
}

export function mentionChipText(
  person: MentionPerson | null,
  _storedLabel?: string | null,
) {
  if (person?.member) return person.name
  if (person) return 'Former member'
  return 'Unknown person'
}

export function createMentionCache() {
  const listed = new Map<string, { id: string; name: string }>()
  return {
    replace(rows: Iterable<{ id: string; name: string }>) {
      listed.clear()
      for (const row of rows) listed.set(row.id, { id: row.id, name: row.name })
    },
    merge(rows: Iterable<{ id: string; name: string }>) {
      for (const row of rows) listed.set(row.id, { id: row.id, name: row.name })
    },
    remember(row: { id: string; name: string }) {
      listed.set(row.id, { id: row.id, name: row.name })
    },
    clear() {
      listed.clear()
    },
    person(id: string, people: MentionPerson[]) {
      return mentionPerson(id, people, listed.values())
    },
  }
}

export function applyMentionQuery(
  cache: {
    merge: (rows: Iterable<{ id: string; name: string }>) => void
    replace: (rows: Iterable<{ id: string; name: string }>) => void
  },
  query: string,
  rows: Iterable<{ id: string; name: string }>,
) {
  if (query.trim() === '') cache.replace(rows)
  else cache.merge(rows)
}
