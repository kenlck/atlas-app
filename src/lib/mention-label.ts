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
  for (const row of listed) {
    if (row.id !== id) continue
    return { id: row.id, name: row.name, member: true }
  }
  return people.find((person) => person.id === id) ?? null
}

export function mentionChipText(
  person: MentionPerson | null,
  _storedLabel?: string | null,
) {
  if (person?.member) return person.name
  if (person && !looksLikeEmail(person.name)) return person.name
  return 'Former member'
}
