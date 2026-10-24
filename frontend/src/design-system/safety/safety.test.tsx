import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axeViolations } from '../../test/axe'
import { BreakGlassDialog } from './BreakGlassDialog'
import { IdleTimeoutWarning } from './IdleTimeoutWarning'
import { ProblemAlert } from './ProblemAlert'
import { RecordChangedDialog } from './RecordChangedDialog'
import { safeInitials, SharedStatusBoard, statusLabel } from './SharedStatusBoard'

describe('BreakGlassDialog', () => {
  it('requires a reason, and a note for Other', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<BreakGlassDialog open onSubmit={onSubmit} onCancel={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Open a restricted chart' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open chart' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Choose a reason.')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /Other/ }))
    await user.click(screen.getByRole('button', { name: 'Open chart' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/Note/)).toBeInvalid()

    await user.type(screen.getByLabelText(/Note/), 'Covering for Dr. Rivera')
    await user.click(screen.getByRole('button', { name: 'Open chart' }))
    expect(onSubmit).toHaveBeenCalledWith({ reasonCode: 'other', reasonText: 'Covering for Dr. Rivera' })
    expect(await axeViolations()).toEqual([])
  })

  it('counts the note against the 500-character limit and refuses a longer one', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<BreakGlassDialog open onSubmit={onSubmit} onCancel={() => {}} />)
    const note = screen.getByLabelText(/Note/)
    expect(note).toHaveAccessibleDescription('500 characters left')

    await user.click(screen.getByRole('radio', { name: /Continuity of care/ }))
    await user.click(note)
    await user.paste('x'.repeat(503)) // pasted text is kept whole, never silently cut
    expect(note).toHaveValue('x'.repeat(503))
    expect(note).toHaveAccessibleDescription('3 characters too many')
    await user.click(screen.getByRole('button', { name: 'Open chart' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Shorten the note to 500 characters or fewer.')).toBeInTheDocument()

    await user.type(note, '{Backspace}{Backspace}{Backspace}')
    await user.click(screen.getByRole('button', { name: 'Open chart' }))
    expect(onSubmit).toHaveBeenCalledWith({ reasonCode: 'continuity-of-care', reasonText: 'x'.repeat(500) })
  })

  it('sends the reason code alone when no note is given', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<BreakGlassDialog open onSubmit={onSubmit} onCancel={() => {}} />)
    await user.click(screen.getByRole('radio', { name: /Emergency care/ }))
    await user.click(screen.getByRole('button', { name: 'Open chart' }))
    expect(onSubmit).toHaveBeenCalledWith({ reasonCode: 'emergency-care' })
  })
})

describe('SharedStatusBoard', () => {
  it('shows initials, time in the facility zone and status only', async () => {
    render(
      <SharedStatusBoard
        timeZone="America/Chicago"
        items={[
          { appointmentId: '1', initials: 'RK', startAt: '2026-11-03T14:30:00Z', status: 'checked-in', visitStatus: 'roomed' },
          { appointmentId: '2', initials: 'Ramona Kuhlman', startAt: '2026-11-03T15:00:00Z', status: 'booked' },
        ]}
      />,
    )
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('RK8:30 AMIn exam room')
    // A full name sent by mistake is never displayed.
    expect(rows[2]).toHaveTextContent('—9:00 AMScheduled')
    expect(screen.queryByText(/Ramona/)).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('labels statuses in U.S. terms', () => {
    expect(statusLabel('noshow')).toBe('No-show')
    expect(statusLabel('checked-in', 'with-provider')).toBe('With provider')
    expect(statusLabel('something-new')).toBe('something-new')
    expect(statusLabel('booked', 'left-without-being-seen', { unknown: 'dash' })).toBe('Scheduled')
    expect(statusLabel('left-without-being-seen', undefined, { unknown: 'dash' })).toBe('—')
    expect(safeInitials('r.k.')).toBe('RK')
  })
})

describe('RecordChangedDialog', () => {
  it('shows both versions and offers only safe choices', async () => {
    const user = userEvent.setup()
    const onUseLatest = vi.fn()
    render(
      <RecordChangedDialog
        open
        changes={[{ label: 'Mobile phone', yours: '(617) 555-0123', current: '(617) 555-0199' }]}
        onUseLatest={onUseLatest}
        onKeepMine={() => {}}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'This record was changed' })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /Mobile phone/ })).toHaveTextContent('(617) 555-0123(617) 555-0199')
    expect(screen.queryByRole('button', { name: /save anyway|overwrite/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use the latest version' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Use the latest version' }))
    expect(onUseLatest).toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })
})

describe('IdleTimeoutWarning', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('warns 2 minutes before idle logout, counts down and expires', async () => {
    vi.useFakeTimers()
    const start = Date.parse('2026-11-03T14:00:00Z')
    let clock = start
    const onExpired = vi.fn()
    render(
      <IdleTimeoutWarning
        idleExpiresAt="2026-11-03T14:15:00Z"
        expiresAt="2026-11-04T02:00:00Z"
        onStaySignedIn={async () => {}}
        onSignOut={() => {}}
        onExpired={onExpired}
        now={() => clock}
      />,
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    clock = start + 13 * 60_000
    act(() => vi.advanceTimersByTime(1000))
    const dialog = screen.getByRole('alertdialog', { name: 'Are you still there?' })
    expect(dialog).toHaveTextContent('2:00')
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toHaveFocus()

    clock = start + 15 * 60_000
    act(() => vi.advanceTimersByTime(1000))
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('drives its own busy state and shows an error if the refresh fails', async () => {
    const clock = Date.parse('2026-11-03T14:13:30Z')
    const onStaySignedIn = vi.fn().mockRejectedValue(new Error('network'))
    render(
      <IdleTimeoutWarning
        idleExpiresAt="2026-11-03T14:15:00Z"
        expiresAt="2026-11-04T02:00:00Z"
        onStaySignedIn={onStaySignedIn}
        onSignOut={() => {}}
        onExpired={() => {}}
        now={() => clock}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stay signed in' }))
    expect(onStaySignedIn).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("Couldn't keep you signed in")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toBeEnabled()
  })

  it('gives notice before the 12-hour limit, which cannot be extended', () => {
    vi.useFakeTimers()
    const clock = Date.parse('2026-11-04T01:50:00Z')
    render(
      <IdleTimeoutWarning
        idleExpiresAt="2026-11-04T02:05:00Z"
        expiresAt="2026-11-04T02:00:00Z"
        onStaySignedIn={async () => {}}
        onSignOut={() => {}}
        onExpired={() => {}}
        now={() => clock}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Your session ends in 10 minutes')
    // "Stay signed in" would not help here, so the idle dialog is not shown.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

describe('ProblemAlert', () => {
  it('uses screen copy by code, lists field errors and the reference', async () => {
    render(
      <ProblemAlert
        fieldLabels={{ '/birthDate': 'Date of birth' }}
        problem={{
          type: 'tag:company-domain.invalid,2026:problem/validation-failed',
          title: 'Request validation failed',
          status: 422,
          code: 'validation-failed',
          detail: 'server text the screen ignores',
          requestId: 'b3c4',
          errors: [{ in: 'body', pointer: '/birthDate', code: 'required' }],
        }}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Check the highlighted fields')
    expect(alert).toHaveTextContent('Date of birth: This is required.')
    expect(alert).toHaveTextContent('Reference: b3c4')
    expect(alert).not.toHaveTextContent('server text the screen ignores')
    expect(await axeViolations()).toEqual([])
  })
})
