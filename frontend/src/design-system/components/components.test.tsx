import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { axeViolations } from '../../test/axe'
import { Button } from './Button'
import { DataTable } from './DataTable'
import { Field } from './Field'
import { Alert, Badge, ErrorState } from './feedback'
import { DateInput, MoneyInput, PhoneInput, StateSelect, Textarea, TextInput } from './inputs'
import { ConfirmDialog } from './Modal'
import { Tabs } from './Tabs'

describe('form fields', () => {
  function Form({ onDate, onPhone }: { onDate: (v: string | null) => void; onPhone: (v: string | null) => void }) {
    return (
      <form>
        <Field label="Date of birth" hint="MM/DD/YYYY" required error="Enter a real date.">
          {(p) => <DateInput {...p} value="" onValueChange={onDate} />}
        </Field>
        <Field label="Mobile phone">{(p) => <PhoneInput {...p} value="" onValueChange={onPhone} />}</Field>
        <Field label="State">{(p) => <StateSelect {...p} />}</Field>
      </form>
    )
  }

  it('labels controls and links hint and error', async () => {
    render(<Form onDate={() => {}} onPhone={() => {}} />)
    const dob = screen.getByLabelText(/Date of birth/)
    expect(dob).toHaveAccessibleDescription('MM/DD/YYYY Enter a real date.')
    expect(dob).toBeInvalid()
    expect(dob).toBeRequired()
    expect(await axeViolations()).toEqual([])
  })

  it('emits contract values from U.S. input', async () => {
    const user = userEvent.setup()
    const dates: Array<string | null> = []
    const phones: Array<string | null> = []
    render(<Form onDate={(v) => dates.push(v)} onPhone={(v) => phones.push(v)} />)
    await user.type(screen.getByLabelText(/Date of birth/), '07/19/1984')
    expect(dates.at(-1)).toBe('1984-07-19')
    const phone = screen.getByLabelText('Mobile phone')
    await user.type(phone, '6175550123')
    expect(phones.at(-1)).toBe('+16175550123')
    await user.tab()
    expect(phone).toHaveValue('(617) 555-0123')
  })

  it('lists states by name with USPS codes as values', () => {
    render(<Form onDate={() => {}} onPhone={() => {}} />)
    expect(screen.getByRole('option', { name: 'Illinois (IL)' })).toHaveValue('IL')
  })

  it('uses a given id, so an error summary can link to the control', () => {
    render(
      <>
        <Field id="email" label="Email" hint="name@example.com" error="Enter an email address">
          {(p) => <TextInput {...p} />}
        </Field>
        <Field label="City">{(p) => <TextInput {...p} />}</Field>
      </>,
    )
    const email = screen.getByLabelText('Email')
    expect(email).toHaveAttribute('id', 'email')
    expect(email).toHaveAttribute('aria-describedby', 'email-hint email-error')
    expect(email).toHaveAccessibleDescription('name@example.com Enter an email address')
    // Without an id, one is generated and still links the label.
    expect(screen.getByLabelText('City').id).not.toBe('')
  })
})

describe('MoneyInput', () => {
  it('keeps the amount a decimal string and groups it once valid', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(
      <Field label="Copay amount (USD)">{(p) => <MoneyInput {...p} value="" onValueChange={onValue} />}</Field>,
    )
    const input = screen.getByLabelText('Copay amount (USD)')
    await user.type(input, '1234.5')
    expect(onValue).toHaveBeenLastCalledWith('1234.50')
    await user.tab()
    expect(input).toHaveValue('1,234.50')
    expect(await axeViolations()).toEqual([])
  })

  it('reports invalid and negative amounts as null, unless negatives are allowed', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    const onRefund = vi.fn()
    render(
      <>
        <Field label="Copay amount (USD)">{(p) => <MoneyInput {...p} value="" onValueChange={onValue} />}</Field>
        <Field label="Adjustment (USD)">{(p) => <MoneyInput {...p} value="" allowNegative onValueChange={onRefund} />}</Field>
      </>,
    )
    await user.type(screen.getByLabelText('Copay amount (USD)'), '-5')
    expect(onValue).toHaveBeenLastCalledWith(null)
    await user.type(screen.getByLabelText('Adjustment (USD)'), '-5')
    expect(onRefund).toHaveBeenLastCalledWith('-5.00')
  })

  it('shows a stored amount without the sign it draws beside the field', () => {
    render(<Field label="Balance (USD)">{(p) => <MoneyInput {...p} value="25.00" onValueChange={() => {}} />}</Field>)
    expect(screen.getByLabelText('Balance (USD)')).toHaveValue('25.00')
  })
})

describe('Textarea', () => {
  function Note({ limit }: { limit?: number }) {
    const [value, setValue] = useState('')
    return (
      <Field label="Note" hint="Shown to the privacy officer">
        {(p) => <Textarea {...p} value={value} {...(limit === undefined ? {} : { limit })} onChange={(e) => setValue(e.target.value)} />}
      </Field>
    )
  }

  it('reads the hint and the remaining count with the field', async () => {
    const user = userEvent.setup()
    render(<Note limit={10} />)
    const note = screen.getByLabelText('Note')
    expect(note).toHaveAccessibleDescription('Shown to the privacy officer 10 characters left')
    await user.type(note, 'abcdefghi')
    expect(note).toHaveAccessibleDescription('Shown to the privacy officer 1 character left')
    expect(await axeViolations()).toEqual([])
  })

  it('keeps text past the limit, marks the field invalid and counts the excess', async () => {
    const user = userEvent.setup()
    render(<Note limit={5} />)
    const note = screen.getByLabelText('Note')
    await user.type(note, 'abcdefg')
    expect(note).toHaveValue('abcdefg')
    expect(note).toBeInvalid()
    expect(note).toHaveAccessibleDescription('Shown to the privacy officer 2 characters too many')
  })

  it('shows no count without a limit', () => {
    render(<Note />)
    expect(screen.getByLabelText('Note')).toHaveAccessibleDescription('Shown to the privacy officer')
  })
})

describe('feedback', () => {
  it('names alert severity in words, not only colour', async () => {
    render(
      <>
        <Alert tone="critical" title="Allergy: penicillin" />
        <Alert tone="info" title="Copay collected" />
        <Badge tone="warning">Pending</Badge>
      </>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Critical: Allergy: penicillin')
    expect(screen.getByRole('status')).toHaveTextContent('Note: Copay collected')
    expect(await axeViolations()).toEqual([])
  })

  it('shows the reference id and retry on a failed panel', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(<ErrorState title="Couldn't load appointments" reference="req-123" onRetry={onRetry} />)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
    expect(screen.getByText('Reference: req-123')).toBeInTheDocument()
  })
})

describe('ConfirmDialog', () => {
  it('traps focus, starts on Cancel, closes on Escape and restores focus', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Button onClick={() => setOpen(true)}>Cancel appointment</Button>
          <ConfirmDialog open={open} title="Cancel this appointment?" confirmLabel="Cancel appointment" cancelLabel="Keep it" confirmVariant="danger" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}>
            The patient will be told by text message.
          </ConfirmDialog>
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Cancel appointment' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Cancel this appointment?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus()
    expect(await axeViolations()).toEqual([])
    await user.tab()
    await user.tab()
    await user.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })
})

describe('Tabs', () => {
  it('moves with arrow keys and keeps one tab stop', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [id, setId] = useState('coverage')
      return (
        <Tabs
          label="Patient"
          selectedId={id}
          onSelect={setId}
          items={[
            { id: 'coverage', label: 'Insurance', panel: <p>Insurance panel</p> },
            { id: 'consents', label: 'Consents', count: 2, panel: <p>Consents panel</p> },
          ]}
        />
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole('tab', { name: 'Insurance' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /Consents/ })).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Consents panel')
    expect(screen.getByRole('tab', { name: 'Insurance' })).toHaveAttribute('tabindex', '-1')
    expect(await axeViolations()).toEqual([])
  })
})

describe('DataTable', () => {
  it('uses Load more for cursor lists and an empty state', async () => {
    const user = userEvent.setup()
    const onLoadMore = vi.fn()
    const { rerender } = render(
      <DataTable
        caption="Appointments"
        columns={[{ key: 'time', header: 'Time', render: (r: { id: string; time: string }) => r.time }]}
        rows={[{ id: 'a', time: '8:30 AM' }]}
        rowKey={(r) => r.id}
        hasMore
        onLoadMore={onLoadMore}
      />,
    )
    expect(screen.getByRole('table', { name: 'Appointments' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(onLoadMore).toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
    rerender(<DataTable caption="Appointments" columns={[]} rows={[]} rowKey={() => ''} emptyTitle="No appointments today" />)
    expect(screen.getByText('No appointments today')).toBeInTheDocument()
  })
})
