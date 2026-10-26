import { vi } from 'vitest'

// Helpers for screen tests that talk to the API through the real fetch wrapper. Synthetic data only.

export const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })

export const problem = (status: number, code: string, extra: object = {}) =>
  json(status, { type: 'about:blank', title: code, status, code, ...extra }, 'application/problem+json')

/**
 * A fake server: answers by "METHOD /path?query". Each route takes a list of responses (made fresh
 * per call); the last one repeats. Unknown routes fail the request, so a test sees every call.
 */
export function serve(routes: Record<string, Array<() => Response>>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const list = routes[key]
    if (!list) throw new Error(`unexpected ${key}`)
    return (list.length > 1 ? list.shift()! : list[0]!)()
  })
  vi.stubGlobal('fetch', fetchMock)
  const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)
  const bodies = (key: string) =>
    fetchMock.mock.calls
      .filter(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
      .map(([, init]) => ({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) }))
  return { calls, bodies }
}
