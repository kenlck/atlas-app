export const TITLE_MAX = 200

// A title already past the cap can stay that length or get shorter.
// Growth stops at the longer of the cap and the text already there.
export function clampTitle(previous: string, incoming: string) {
  const cap = Math.max(TITLE_MAX, previous.length)
  if (incoming.length <= cap) return incoming
  return incoming.slice(0, cap)
}

// Blur keeps the field as it is. Typing and paste go through the cap.
export function nextTitle(
  previous: string,
  incoming: string,
  source: 'input' | 'blur',
) {
  if (source === 'blur') return incoming
  return clampTitle(previous, incoming)
}
