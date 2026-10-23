export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export function notFound(): never {
  throw new HttpError(404, 'Not found')
}

export function unauthorized(): never {
  throw new HttpError(401, 'Unauthorized')
}

export function forbidden(): never {
  throw new HttpError(403, 'Password change required')
}
