import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import type { PasswordHelpHandlers, RequestOutcome } from '../../../shri-health/passwordHelp'
import { RequestPage, SENT_TEXT, SENT_TITLE } from './RequestPage'

// /password-help: the request form (#85). Plain stand-ins for the handlers. Synthetic usernames only.
const TOKEN = 'request-token-for-unit-tests'

function handlers(outcome: RequestOutcome | (() => Promise<RequestOutcome>)) {
  const sent: string[] = []
  const h: PasswordHelpHandlers = {
    requestReset: (username) => {
      sent.push(username)
      return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome)
    },
    readStatus: () => Promise.resolve({ kind: 'ready', status: 'waiting' }),
  }
  return { h, sent }
}

function open(h: PasswordHelpHandlers) {
  return render(
    <MemoryRouter initialEntries={['/password-help']}>
      <RequestPage handlers={h} signInHref="/" />
    </MemoryRouter>,
  )
}

async function send(username: string) {
  fireEvent.change(screen.getByLabelText(/Username/), { target: { value: username } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
  })
}

beforeEach(() => sessionStorage.clear())

describe('the request form', () => {
  it('sends the username to the handler only (no URL), and keeps the token for this tab', async () => {
    const { h, sent } = handlers({ kind: 'accepted', statusToken: TOKEN })
    open(h)
    await send('  example.staff  ')
    expect(sent).toEqual(['example.staff'])
    expect(window.location.href).not.toContain('example.staff')
    expect(sessionStorage.getItem('shri.passwordHelp.statusToken')).toBe(TOKEN)
    expect(window.location.href).not.toContain(TOKEN)
    expect(screen.getByRole('link', { name: 'Check the status of your request' }).getAttribute('href')).toBe('/password-help/status')
  })

  it('gives exactly the same answer whether or not the account exists', async () => {
    const known = handlers({ kind: 'accepted', statusToken: TOKEN })
    const a = open(known.h)
    await send('example.staff')
    const first = a.container.innerHTML
    a.unmount()
    const unknown = handlers({ kind: 'accepted', statusToken: 'another-token-for-unit-tests' })
    const b = open(unknown.h)
    await send('nobody.example')
    expect(b.container.innerHTML).toBe(first)
    expect(screen.getByText(SENT_TITLE)).toBeTruthy()
    expect(screen.getByText(SENT_TEXT)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/not found|no account|doesn't exist|does not exist|unknown user/i)
  })

  it('asks for a username before sending, and sends nothing', async () => {
    const { h, sent } = handlers({ kind: 'accepted', statusToken: TOKEN })
    open(h)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    })
    expect(sent).toEqual([])
    expect(screen.getByText('Enter your username.')).toBeTruthy()
    expect(screen.getByLabelText(/Username/).getAttribute('aria-invalid')).toBe('true')
  })

  it('is busy while sending, then announces the answer and moves focus to it', async () => {
    let finish: (o: RequestOutcome) => void = () => undefined
    const { h } = handlers(() => new Promise<RequestOutcome>((resolve) => (finish = resolve)))
    open(h)
    await send('example.staff')
    expect(screen.getByRole('button', { name: 'Send request' }).getAttribute('aria-busy')).toBe('true')
    await act(async () => finish({ kind: 'accepted', statusToken: TOKEN }))
    const answer = screen.getByRole('status')
    expect(answer.getAttribute('aria-live')).toBe('polite')
    await waitFor(() => expect(document.activeElement).toBe(answer))
  })

  it.each([
    [{ kind: 'rate-limited' } as const, 'Too many requests'],
    [{ kind: 'unavailable' } as const, "Password help isn't available right now"],
    [{ kind: 'error' } as const, "We couldn't send your request"],
  ])('says so for %o, keeps the form, and keeps no token', async (outcome, title) => {
    const { h } = handlers(outcome)
    open(h)
    await send('example.staff')
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send request' })).toBeTruthy()
    expect(sessionStorage.getItem('shri.passwordHelp.statusToken')).toBeNull()
  })

  it('treats a failed call as an error', async () => {
    const { h } = handlers(() => Promise.reject(new Error('offline')))
    open(h)
    await send('example.staff')
    expect(screen.getByText("We couldn't send your request")).toBeTruthy()
  })

  it('has no password field', () => {
    const { h } = handlers({ kind: 'accepted', statusToken: TOKEN })
    const { container } = open(h)
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })
})
