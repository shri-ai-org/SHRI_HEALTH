import { describe, expect, it, vi } from 'vitest'

import { forgetStatusToken, keepStatusToken, notYetConnected, passwordHelpOn, takeStatusToken } from './passwordHelp'

// The status token's handling on the "Forgot password?" status page (#85). Synthetic values only.
const TOKEN = 'status-token-for-unit-tests'

function place(hash: string, kept: Record<string, string> = {}) {
  const store = { ...kept }
  const replaceState = vi.fn()
  return {
    store,
    replaceState,
    place: {
      location: { hash, pathname: '/password-help/status', search: '' },
      history: { replaceState, state: null },
      storage: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => void (store[key] = value),
        removeItem: (key: string) => void delete store[key],
      },
    },
  }
}

describe('the status token', () => {
  it('is taken from the fragment, which is then removed from the address, and kept for this tab only', () => {
    const p = place(`#status=${TOKEN}`)
    expect(takeStatusToken(p.place)).toBe(TOKEN)
    expect(p.replaceState).toHaveBeenCalledWith(null, '', '/password-help/status')
    expect(String(p.replaceState.mock.calls[0][2])).not.toContain(TOKEN)
    expect(Object.values(p.store)).toEqual([TOKEN])
  })

  it('is read from this tab’s storage after a reload, with no fragment to remove', () => {
    const p = place('', { 'shri.passwordHelp.statusToken': TOKEN })
    expect(takeStatusToken(p.place)).toBe(TOKEN)
    expect(p.replaceState).not.toHaveBeenCalled()
  })

  it('ignores a fragment that is not a token, and still removes it from the address', () => {
    const p = place('#status=<script>')
    expect(takeStatusToken(p.place)).toBeNull()
    expect(p.replaceState).toHaveBeenCalledOnce()
    expect(p.store).toEqual({})
  })

  it('is null when there is none, and survives blocked storage', () => {
    expect(takeStatusToken(place('').place)).toBeNull()
    const blocked = place(`#status=${TOKEN}`)
    blocked.place.storage.setItem = () => {
      throw new Error('blocked')
    }
    expect(takeStatusToken(blocked.place)).toBe(TOKEN)
  })

  it('is kept and forgotten in storage only', () => {
    const p = place('')
    keepStatusToken(TOKEN, p.place)
    expect(p.store).toEqual({ 'shri.passwordHelp.statusToken': TOKEN })
    forgetStatusToken(p.place)
    expect(p.store).toEqual({})
  })
})

describe('the switch and the handlers before the contract', () => {
  it('is on only when the build sets VITE_FEATURE_PASSWORD_HELP=on', () => {
    expect(passwordHelpOn({ VITE_FEATURE_PASSWORD_HELP: 'on' })).toBe(true)
    expect(passwordHelpOn({})).toBe(false)
    expect(passwordHelpOn({ VITE_FEATURE_PASSWORD_HELP: 'true' })).toBe(false)
  })

  it('answers "unavailable" for every call, never a made-up result', async () => {
    expect(await notYetConnected.requestReset('example.user')).toEqual({ kind: 'unavailable' })
    expect(await notYetConnected.readStatus(TOKEN)).toEqual({ kind: 'ready', status: 'unavailable' })
  })
})
