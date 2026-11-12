import {
  CYCLE_REPLAY_MESSAGE,
  exactReplayAccepts,
  statusOnlyAcceptsReplay,
} from './replay-message.ts'

function seroval(message: string, stack: string) {
  return JSON.stringify({
    t: 13,
    i: 1,
    s: 0,
    m: message,
    p: { k: ['stack'], v: [{ t: 1, s: stack }] },
  })
}

const cycle = CYCLE_REPLAY_MESSAGE
const planted = seroval('Bad request', `HttpError: ${cycle}\n    at main`)
const good = seroval(cycle, `HttpError: ${cycle}\n    at movePage`)
const looseStack = seroval('Bad request', cycle)

const mainAcceptsPlanted = statusOnlyAcceptsReplay(400)
const headRejectsPlanted = !exactReplayAccepts(400, planted)
const headAcceptsCycle = exactReplayAccepts(400, good)
const looseWouldMatch = looseStack.includes(cycle)
const headRejectsLoose = !exactReplayAccepts(400, looseStack)
const headRejectsStatus = !exactReplayAccepts(200, good)

console.log(`fc1_main_accepts_planted=${mainAcceptsPlanted}`)
console.log(`fc1_head_rejects_planted=${headRejectsPlanted}`)
console.log(`fc1_head_accepts_cycle=${headAcceptsCycle}`)
console.log(`fc1_loose_would_match=${looseWouldMatch}`)
console.log(`fc1_head_rejects_loose=${headRejectsLoose}`)
console.log(`fc1_head_rejects_wrong_status=${headRejectsStatus}`)

if (
  !mainAcceptsPlanted ||
  !headRejectsPlanted ||
  !headAcceptsCycle ||
  !looseWouldMatch ||
  !headRejectsLoose ||
  !headRejectsStatus
) {
  console.log('fc1=fail')
  process.exit(1)
}

console.log('fc1=pass')
