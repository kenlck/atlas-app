import { forbidden, unauthorized } from './http'

export function assertApiSession(input: {
  hasSession: boolean
  mustChangePassword: boolean
}) {
  if (!input.hasSession) unauthorized()
  if (input.mustChangePassword) forbidden()
}
