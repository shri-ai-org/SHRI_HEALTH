import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import type { PasswordHelpHandlers, StatusViewState } from '../../../shri-health/passwordHelp'
import { StatusPage } from './StatusPage'

// /password-help/status: information only, reached with the request's status token (#85).
const TOKEN = 'status-page-token-for-tests'

type Answer = Exclude<StatusViewState, { kind: 'loading' } | { kind: 'no-token' }>

function handlers(answer: Answer | (() => Promise<Answer>)) {
  const asked: string[] = []
  const h: PasswordHelpHandlers = {
    requestReset: () => Promise.resolve({ kind: 'unavailable' }),
    readStatus: (token) => {
      asked.push(token)
      return typeof answer === 'function' ? answer() : Promise.resolve(answer)
    },
  }
  return { h, asked }
}

async function open(h: PasswordHelpHandlers) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={['/password-help/status']}>
        <StatusPage handlers={h} signInHref="/" />
      </MemoryRouter>,
    )
  })
  return result
}

beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState(null, '', '/password-help/status')
})

describe('the status page', () => {
  it('takes the token from the fragment, removes it from the address, and sends it only to the handler', async () => {
    window.history.replaceState(null, '', `/password-help/status#status=${TOKEN}`)
    const { h, asked } = handlers({ kind: 'ready', status: 'waiting' })
    const { container } = await open(h)
    expect(asked).toEqual([TOKEN])
    expect(window.location.href).not.toContain(TOKEN)
    expect(window.location.hash).toBe('')
    expect(container.innerHTML).not.toContain(TOKEN)
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).not.toContain(TOKEN)
  })

  it('takes a token that arrives while the page is open, and removes it from the address too', async () => {
    const { h, asked } = handlers({ kind: 'ready', status: 'waiting' })
    await open(h)
    expect(asked).toEqual([])
    await act(async () => {
      window.history.replaceState(null, '', `/password-help/status#status=${TOKEN}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(asked).toEqual([TOKEN])
    expect(window.location.hash).toBe('')
  })

  it('reads the token kept for this tab after a reload', async () => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    const { h, asked } = handlers({ kind: 'ready', status: 'waiting' })
    await open(h)
    expect(asked).toEqual([TOKEN])
  })

  it('says so when there is no token, and asks nothing', async () => {
    const { h, asked } = handlers({ kind: 'ready', status: 'waiting' })
    await open(h)
    expect(asked).toEqual([])
    expect(screen.getByText('No request to show')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Send a new request' }).getAttribute('href')).toBe('/password-help')
  })

  it('shows "Checking your request…" while it reads', async () => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    const { h } = handlers(() => new Promise<Answer>(() => undefined))
    await open(h)
    expect(screen.getByText('Checking your request…')).toBeTruthy()
  })

  it.each([
    ['waiting', 'Waiting for the administrator', false],
    ['approved', 'Approved', false],
    ['declined', 'Declined', true],
    ['expired', 'Expired', true],
    ['unavailable', "This request can't be shown", true],
  ] as const)('shows %s as "%s", with no password field or reset link', async (status, title, newRequest) => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    const { h } = handlers({ kind: 'ready', status })
    const { container } = await open(h)
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(container.querySelector('input')).toBeNull()
    expect(screen.queryByRole('link', { name: /set a new password|reset/i })).toBeNull()
    expect(Boolean(screen.queryByRole('link', { name: 'Send a new request' }))).toBe(newRequest)
  })

  it.each(['approved', 'declined', 'expired', 'unavailable'] as const)('forgets the token once the request is %s', async (status) => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    await open(handlers({ kind: 'ready', status }).h)
    expect(sessionStorage.getItem('shri.passwordHelp.statusToken')).toBeNull()
  })

  it('keeps the token while the request is waiting, or when the check failed', async () => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    const waiting = await open(handlers({ kind: 'ready', status: 'waiting' }).h)
    expect(sessionStorage.getItem('shri.passwordHelp.statusToken')).toBe(TOKEN)
    waiting.unmount()
    await open(handlers({ kind: 'error' }).h)
    expect(sessionStorage.getItem('shri.passwordHelp.statusToken')).toBe(TOKEN)
  })

  it('never puts the token in the document title', async () => {
    window.history.replaceState(null, '', `/password-help/status#status=${TOKEN}`)
    await open(handlers({ kind: 'ready', status: 'waiting' }).h)
    expect(document.title).not.toContain(TOKEN)
  })

  it('says to check email once approved', async () => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    await open(handlers({ kind: 'ready', status: 'approved' }).h)
    expect(screen.getByText('Check your email for a link to set a new password.')).toBeTruthy()
  })

  it('shows the administrator’s note on a decline', async () => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    await open(handlers({ kind: 'ready', status: 'declined', note: 'Example note from the administrator.' }).h)
    expect(screen.getByText('Example note from the administrator.')).toBeTruthy()
  })

  it.each([
    [{ kind: 'error' } as const, "We couldn't check your request"],
    [{ kind: 'rate-limited' } as const, 'Too many checks'],
  ])('says so for %o and tries again on "Try again"', async (answer, title) => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    const { h, asked } = handlers(answer)
    await open(h)
    expect(screen.getByText(title)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    expect(asked).toEqual([TOKEN, TOKEN])
  })

  it('treats a failed call as an error, and moves focus to the answer', async () => {
    sessionStorage.setItem('shri.passwordHelp.statusToken', TOKEN)
    await open(handlers(() => Promise.reject(new Error('offline'))).h)
    expect(screen.getByText("We couldn't check your request")).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('status')))
  })
})
