import { definePlugin } from 'nitro'
import { assertProductionEnv } from '../lib/production-env'

export function installStopSignals() {
  const stop = () => {
    process.exit(0)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

export default definePlugin(() => {
  installStopSignals()
  assertProductionEnv()
})
