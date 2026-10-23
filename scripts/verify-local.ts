// Refuse anything except an http URL on localhost. Called when a driver loads.
export function assertLocalBaseUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('refusing non-local BASE_URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'http:' || !local) {
    throw new Error('refusing non-local BASE_URL')
  }
  return url.toString().replace(/\/$/, '')
}

export function stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function waitForClient(page: {
  waitForFunction: (fn: () => boolean) => Promise<unknown>
}) {
  await page.waitForFunction(() =>
    Object.prototype.hasOwnProperty.call(window, '__TSR_ROUTER__'),
  )
}

type AuthPage = {
  waitForFunction: (fn: () => boolean) => Promise<unknown>
  waitForResponse: (
    fn: (response: {
      url: () => string
      status: () => number
      headers: () => Record<string, string>
    }) => boolean,
  ) => Promise<{
    status: () => number
    headers: () => Record<string, string>
  }>
  getByRole: (
    role: 'button',
    options: { name: string },
  ) => { click: () => Promise<void> }
}

export async function submitAuthForm(
  page: AuthPage,
  buttonName: string,
  apiPath: string,
) {
  await waitForClient(page)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pending = page.waitForResponse((response) =>
      response.url().includes(apiPath),
    )
    await page.getByRole('button', { name: buttonName }).click()
    const response = await pending
    console.log(`auth_status=${response.status()} path=${apiPath}`)
    if (response.status() !== 429) return response
    const retryAfter = Number(response.headers()['x-retry-after'] ?? '10')
    const seconds = Number.isFinite(retryAfter) ? retryAfter + 1 : 11
    console.log(`auth_retry_after=${seconds}`)
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }
  throw new Error(`auth stayed rate limited for ${apiPath}`)
}
