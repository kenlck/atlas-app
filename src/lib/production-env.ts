const REQUIRED_IN_PRODUCTION = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'ADMIN_API_SECRET',
] as const

export function assertProductionEnv() {
  // globalThis keeps this a runtime read. Nitro replaces process.env.NODE_ENV
  // with the literal "production" and would otherwise drop the guard.
  const nodeEnv = globalThis.process?.env?.NODE_ENV
  if (nodeEnv !== 'production') return
  for (const name of REQUIRED_IN_PRODUCTION) {
    const value = process.env[name]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${name} is required`)
    }
  }
}
