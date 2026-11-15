import { definePlugin } from 'nitro'
import { assertProductionEnv } from '../lib/production-env'

const STOP_DRAIN_MS = 6000

function drainStopSignals() {
  let draining = false
  const stop = () => {
    if (draining) return
    draining = true
    setTimeout(() => {
      process.exit(0)
    }, STOP_DRAIN_MS)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

export default definePlugin(() => {
  drainStopSignals()
  assertProductionEnv()
})
