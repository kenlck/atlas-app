import { definePlugin } from 'nitro'
import { assertProductionEnv } from '../lib/production-env'

export default definePlugin(() => {
  assertProductionEnv()
})
