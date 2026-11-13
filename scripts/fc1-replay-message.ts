import {
  CYCLE_REPLAY_MESSAGE,
  exactReplayAccepts,
  statusOnlyAcceptsReplay,
} from './replay-message.ts'

function seroval(message: string, stack: string) {
  return JSON.stringify({
    t: 10,
    i: 0,
    p: {
      k: ['error'],
      v: [
        {
          t: 25,
          i: 1,
          s: {
            message: { t: 1, s: message },
            stack: { t: 1, s: stack },
          },
          c: '$TSR/Error',
        },
      ],
    },
    o: 0,
  })
}

const cycle = CYCLE_REPLAY_MESSAGE
const planted = seroval('Bad request', `HttpError: ${cycle}\n    at main`)
const good = seroval(cycle, `HttpError: ${cycle}\n    at movePage`)
const looseStack = seroval('Bad request', cycle)

if (process.argv[2] === 'planted') {
  const accepted = exactReplayAccepts(400, planted)
  console.log(`fc1_planted_accepted=${accepted}`)
  process.exit(accepted ? 0 : 1)
}

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
