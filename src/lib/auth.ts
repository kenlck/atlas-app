import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { getDb } from './db'
import { MIN_PASSWORD } from './password-policy'
import { account, session, user, verification } from './schema'

function makeAuth() {
  const secret = process.env.BETTER_AUTH_SECRET
  const baseURL = process.env.BETTER_AUTH_URL
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is required')
  }
  if (!baseURL) {
    throw new Error('BETTER_AUTH_URL is required')
  }

  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: MIN_PASSWORD,
    },
    user: {
      additionalFields: {
        mustChangePassword: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
    trustedOrigins: [baseURL],
    plugins: [tanstackStartCookies()],
  })
}

type AtlasAuth = ReturnType<typeof makeAuth>
let auth: AtlasAuth | undefined

export function getAuth() {
  if (!auth) {
    auth = makeAuth()
  }
  return auth
}

export { MIN_PASSWORD }
