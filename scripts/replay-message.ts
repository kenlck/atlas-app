export const CYCLE_REPLAY_MESSAGE =
  'Cannot move a page under itself or a descendant'

function decodeJsonString(raw: string): string | null {
  try {
    const message = JSON.parse(`"${raw}"`) as unknown
    return typeof message === 'string' ? message : null
  } catch {
    return raw
  }
}

// Seroval puts the thrown error's message in the first "m" string.
// A stack line can contain the same words inside a longer "s" string.
// Only the "m" field, a JSON message, or a body that is the sentence counts.
export function replayErrorMessage(body: string): string | null {
  const match = /"m":"((?:\\.|[^"\\])*)"/.exec(body)
  const raw = match?.[1]
  if (raw !== undefined) return decodeJsonString(raw)
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown
      error?: { message?: unknown }
    }
    if (typeof parsed.message === 'string') return parsed.message
    if (typeof parsed.error?.message === 'string') return parsed.error.message
  } catch {
    // Plain text, or a body that is not JSON.
  }
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
