export const CYCLE_REPLAY_MESSAGE =
  'Cannot move a page under itself or a descendant'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function serovalString(value: unknown): string | null {
  const record = asRecord(value)
  if (!record || record.t !== 1 || typeof record.s !== 'string') return null
  return record.s
}

// Start serializes a thrown HttpError as seroval type 25. The sentence is
// the message field. A stack string can contain the same words and must not
// count. An older payload puts the sentence in the first "m" string.
function structuredMessage(value: unknown, depth = 0): string | null {
  if (depth > 8) return null
  const record = asRecord(value)
  if (record) {
    const payload = asRecord(record.s)
    if (payload && 'message' in payload) {
      const fromSeroval = serovalString(payload.message)
      if (fromSeroval) return fromSeroval
      if (typeof payload.message === 'string') return payload.message
    }
    if (typeof record.message === 'string') return record.message
    for (const child of Object.values(record)) {
      const found = structuredMessage(child, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!Array.isArray(value)) return null
  for (const child of value) {
    const found = structuredMessage(child, depth + 1)
    if (found) return found
  }
  return null
}

function decodeJsonString(raw: string): string | null {
  try {
    const message = JSON.parse(`"${raw}"`) as unknown
    return typeof message === 'string' ? message : null
  } catch {
    return raw
  }
}

export function replayErrorMessage(body: string): string | null {
  try {
    const structured = structuredMessage(JSON.parse(body) as unknown)
    if (structured) return structured
  } catch {
    // Plain text, or a body that is not JSON.
  }
  const match = /"m":"((?:\\.|[^"\\])*)"/.exec(body)
  const raw = match?.[1]
  if (raw !== undefined) return decodeJsonString(raw)
  const trimmed = body.trim()
  if (trimmed === CYCLE_REPLAY_MESSAGE) return trimmed
  return null
}

export function statusOnlyAcceptsReplay(status: number): boolean {
  return status === 400
}

export function exactReplayAccepts(status: number, body: string): boolean {
  return status === 400 && replayErrorMessage(body) === CYCLE_REPLAY_MESSAGE
}
