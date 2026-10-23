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

export function mentionChipText(
  person: MentionPerson | null,
  storedLabel?: string | null,
) {
  if (person) {
    if (!person.member && looksLikeEmail(person.name)) return 'Former member'
    return person.name
  }
  if (storedLabel && !looksLikeEmail(storedLabel)) return storedLabel
  return 'Former member'
}
