import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { createMockPortalApi, uid } from './api/mockPortalApi'
import type { PortalApi } from './api/portalApi'
import { PortalApp } from './PortalApp'

// Synthetic data only (mockPortalApi): no real patient appears in these tests.

function renderPortal(path = '/portal', api: PortalApi = createMockPortalApi({ latencyMs: 0 })) {
  window.history.replaceState(null, '', path)
  render(
    <ToastProvider>
      <PortalApp api={api} />
    </ToastProvider>,
  )
  return api
}

async function signIn(path = '/portal') {
  const user = userEvent.setup()
  renderPortal(path)
  await user.type(await screen.findByLabelText(/Username/), 'rkuhlman')
  await user.type(screen.getByLabelText(/^Password/), 'a-good-password-1')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  return user
}

async function loaded() {
  await waitFor(() => expect(screen.queryByText(/^Loading/)).toBeNull())
}

describe('sign-in', () => {
  it('lists missing fields and focuses the summary', async () => {
    const user = userEvent.setup()
    renderPortal()
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    const summary = screen.getByRole('alert')
    expect(summary).toHaveTextContent('There are 2 things to fix')
    expect(summary).toHaveFocus()
    expect(await axeViolations()).toEqual([])
  })

  it('does not say which part was wrong', async () => {
    const user = userEvent.setup()
    renderPortal()
    await user.type(await screen.findByLabelText(/Username/), 'someone')
    await user.type(screen.getByLabelText(/^Password/), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/don't match our records/)).toBeInTheDocument()
  })

  it('lands on the page that was asked for', async () => {
    await signIn('/portal/billing')
    expect(await screen.findByRole('heading', { level: 1, name: 'Pay Bills' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/portal/billing')
  })
})

describe('home and menus', () => {
  it('shows the old eight cards and the alerts panel', async () => {
    await signIn()
    for (const card of ['Test Results', 'Health Summary', 'Appointments', 'Messages', 'Prescriptions', 'Billing', 'Video Consult', 'Patient Education']) {
      expect(screen.getAllByRole('link', { name: new RegExp(`^${card}`) }).length).toBeGreaterThan(0)
    }
    const alerts = await screen.findByRole('region', { name: 'Alerts and Reminders' })
    expect(await within(alerts).findAllByText(/You have an appointment on|Today at/)).not.toHaveLength(0)
    expect(await axeViolations()).toEqual([])
  })

  it('has the Health Summary dropdown and the account menu items', async () => {
    const user = await signIn()
    await screen.findByRole('region', { name: 'Alerts and Reminders' })
    await user.click(screen.getByRole('button', { name: /Health Summary/ }))
    const menu = document.getElementById('health-menu')
    if (!menu) throw new Error('no health menu')
    expect(within(menu).getAllByRole('link').map((l) => l.textContent)).toEqual(['Health Issues', 'Health Trends', 'Allergies', 'Immunization', 'Patient Documents', 'Reports', 'Document Template'])
    await user.click(within(menu).getByRole('link', { name: 'Allergies' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Allergies' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: /account menu/ }))
    const account = document.getElementById('account-menu')
    if (!account) throw new Error('no account menu')
    expect(within(account).getAllByRole('link').map((l) => l.textContent)).toEqual(['Demographics', 'E-Signature', 'Change Password'])
    expect(within(account).getByRole('button', { name: 'Log out' })).toBeInTheDocument()
  })
})

describe('records', () => {
  it('opens a result detail by ID, so refresh and links work', async () => {
    const user = await signIn('/portal/test-results')
    await user.click(await screen.findByRole('link', { name: 'Basic metabolic panel' }))
    expect(await screen.findByRole('heading', { level: 1, name: '80048 - Basic metabolic panel - Details' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/portal/test-results/${uid(801)}`)
    expect(screen.getByRole('row', { name: /Potassium/ })).toHaveTextContent('High')
  })
})

describe('prescriptions', () => {
  it('sends a refill and shows the summary with the chosen pharmacy', async () => {
    const user = await signIn('/portal/prescriptions')
    await user.click(await screen.findByRole('checkbox', { name: /Select Lisinopril/ }))
    await user.selectOptions(screen.getByLabelText(/Choose your convenient pharmacy/), 'Placeholder Drug Co.')
    await user.type(screen.getByLabelText(/Message for your provider/), 'Running low, thank you.')
    await user.click(screen.getByRole('button', { name: 'Send Refill Request' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Prescription Refill Summary' })).toBeInTheDocument()
    expect(screen.getByText(/Lisinopril 10 mg tablet/)).toBeInTheDocument()
    expect(screen.getByText(/Placeholder Drug Co\./)).toBeInTheDocument()
  })

  it('asks for a prescription, pharmacy and message first', async () => {
    const user = await signIn('/portal/prescriptions')
    await user.click(await screen.findByRole('button', { name: 'Send Refill Request' }))
    expect(screen.getByRole('alert')).toHaveTextContent('There are 3 things to fix')
  })
})

describe('appointments', () => {
  it('schedules with the one-page form and the time picker', async () => {
    const user = await signIn('/portal/appointments/schedule')
    await user.selectOptions(await screen.findByLabelText(/Select a location/), 'Shri Health Springfield Clinic')
    await user.selectOptions(screen.getByLabelText(/Select appointment type/), 'Office Visit')
    await user.selectOptions(screen.getByLabelText(/Select reason for visit/), 'Annual Physical')
    await waitFor(() => expect(screen.getByLabelText(/Your providers/)).toBeEnabled())
    await user.selectOptions(screen.getByLabelText(/Your providers/), 'Dr. Alvina Hettinger, MD')
    // A weekday two weeks out, in MM/DD/YYYY.
    const d = new Date(Date.now() + 14 * 86_400_000)
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
    const us = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
    await user.type(screen.getByLabelText(/Appointment preferred date/), us)
    await user.selectOptions(screen.getByLabelText(/Duration/), '30')
    await user.selectOptions(screen.getByLabelText(/Reminder preferences/), 'Text message')
    await user.click(screen.getByRole('button', { name: /Preferred time/ }))
    const picker = await screen.findByRole('dialog', { name: 'Select preferred timing' })
    expect(within(picker).getByRole('heading', { name: 'Morning (AM)' })).toBeInTheDocument()
    const first = (await within(picker).findAllByRole('button', { name: /AM|PM/ }))[0]
    if (!first) throw new Error('no open times')
    await user.click(first)
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(await screen.findByText(/Appointment is scheduled successfully on/)).toBeInTheDocument()
  })

  it('cancels an upcoming appointment only after confirming', async () => {
    const user = await signIn(`/portal/appointments/${uid(501)}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel Appointment' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' })
    expect(within(dialog).getByRole('button', { name: 'Keep appointment' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'My Appointments' })).toBeInTheDocument()
    expect(await screen.findByText('Your appointment is canceled')).toBeInTheDocument()
  })
})

describe('messages', () => {
  it('composes and sends a message', async () => {
    const user = await signIn('/portal/messages/compose')
    await user.selectOptions(await screen.findByLabelText(/^To/), 'Dr. Alvina Hettinger, MD')
    await user.selectOptions(screen.getByLabelText(/^Subject/), 'Non Urgent Medical Question')
    await user.type(screen.getByLabelText(/^Message/), 'I felt dizzy this morning.')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Message sent successfully.')).toBeInTheDocument()
  })

  it('opens a message, moves it to trash, then deletes it after confirming', async () => {
    const user = await signIn('/portal/messages/inbox')
    await user.click(await screen.findByRole('button', { name: 'Non Urgent Medical Question' }))
    const reader = await screen.findByRole('dialog', { name: 'Inbox' })
    expect(reader).toHaveTextContent('Dr. Alvina Hettinger, MD')
    await user.click(within(reader).getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('checkbox', { name: /Select message: Non Urgent Medical Question/ }))
    await user.click(screen.getByRole('button', { name: /Move to trash/ }))
    expect(await screen.findByText('Message moved to trash successfully')).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: /Trash/ }))
    await user.click(await screen.findByRole('checkbox', { name: /Select message: Non Urgent Medical Question/ }))
    await user.click(screen.getByRole('button', { name: /^Delete/ }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete these messages?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Message deleted successfully')).toBeInTheDocument()
  })
})

describe('billing and documents', () => {
  it('pays through the bill, Proceed to Pay and the processor token, never a card number', async () => {
    const user = await signIn('/portal/billing')
    await user.click((await screen.findAllByRole('button', { name: /^Pay Annual Physical/ }))[0] as HTMLElement)
    await user.click(within(await screen.findByRole('dialog', { name: 'Medical Bill' })).getByRole('button', { name: 'Proceed to Pay' }))
    const pay = await screen.findByRole('dialog', { name: 'Payment Details' })
    expect(within(pay).queryByLabelText(/card number/i)).toBeNull()
    await user.click(within(pay).getByRole('button', { name: 'Use a test card (mock)' }))
    await user.click(within(pay).getByRole('button', { name: 'Pay Now' }))
    expect(await screen.findByText(/Transaction completed\. We received \$65\.00/)).toBeInTheDocument()
  })

  it('will not send a document template for review before it is signed', async () => {
    const user = await signIn(`/portal/document-templates/${uid(1601)}`)
    await user.type(await screen.findByLabelText('Main reason for your visit'), 'Blood pressure check')
    await user.click(screen.getByRole('button', { name: 'Review' }))
    expect(await screen.findByText('Sign the document before sending it for review.')).toBeInTheDocument()
  })
})

describe('registration', () => {
  it('goes through all 11 pages and shows the success message', async () => {
    const user = userEvent.setup()
    renderPortal('/portal/register')
    expect(await screen.findByRole('heading', { level: 1, name: 'Registration Form' })).toBeInTheDocument()
    // The patient's fields come before the emergency contact's fields with the same labels.
    const type = async (label: RegExp, text: string) => user.type(screen.getAllByLabelText(label)[0] as HTMLElement, text)
    await type(/^First Name/, 'Lucia')
    await type(/^Last Name/, 'Rempel')
    await type(/^Date of Birth/, '03/14/1990')
    await type(/^Phone Number/, '2175550145')
    await type(/^Email/, 'lucia.rempel@example.com')
    await type(/^Address Line/, '12 Sample St')
    await type(/^City/, 'Springfield')
    await user.selectOptions(screen.getByLabelText(/^State/), 'IL')
    await type(/^ZIP Code/, '62701')
    await user.selectOptions(screen.getByLabelText(/^Marital Status/), 'Single')
    await user.click(screen.getByRole('radio', { name: 'Female' }))
    const ec = screen.getByRole('region', { name: 'Emergency Contact' })
    await user.type(within(ec).getByLabelText(/^First Name/), 'Mateo')
    await user.type(within(ec).getByLabelText(/^Last Name/), 'Rempel')
    await user.type(within(ec).getByLabelText(/^Phone Number/), '2175550146')
    await user.selectOptions(within(ec).getByLabelText(/^Relationship/), 'Sibling')
    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Choices' })).toBeInTheDocument()
    for (const group of ['Allow Patient Portal', 'Allow SMS', 'Allow Email']) {
      await user.click(within(screen.getByRole('group', { name: new RegExp(group) })).getByRole('radio', { name: 'Yes' }))
    }
    await user.click(screen.getByRole('radio', { name: 'Myself' }))
    await user.click(screen.getByRole('radio', { name: 'Self pay' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Preferred Pharmacy' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(within(screen.getByRole('group', { name: /taking any medications/ })).getByRole('radio', { name: 'No' }))
    await user.click(within(screen.getByRole('group', { name: /any allergies/ })).getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    for (const page of ['Past Medical History', 'Family History', 'Social History', 'Surgical History', 'Hospitalization/Procedure']) {
      expect(await screen.findByRole('heading', { level: 2, name: page })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Next' }))
    }
    expect(await screen.findByRole('heading', { level: 2, name: 'Consent Forms' })).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'I agree to the information above.' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Review' })).toBeInTheDocument()
    expect(screen.getByText('Lucia Rempel')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('dialog', { name: 'Registration successful' })).toBeInTheDocument()
  })

  it('stops on page 1 until the required fields are filled', async () => {
    const user = userEvent.setup()
    renderPortal('/portal/register')
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Basic Information' })).toBeInTheDocument()
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/things to fix/)
  })
})

describe('accessibility of every page', () => {
  const pages = [
    ['/portal/test-results', 'Test Results'],
    [`/portal/test-results/${uid(801)}`, '80048 - Basic metabolic panel - Details'],
    ['/portal/health-issues', 'Medical Problems'],
    [`/portal/health-issues/${uid(901)}`, 'Essential hypertension - Problem'],
    ['/portal/health-trends', 'Health Trends'],
    ['/portal/allergies', 'Allergies'],
    [`/portal/allergies/${uid(1001)}`, 'Allergy - Penicillin'],
    ['/portal/immunizations', 'Immunization'],
    [`/portal/immunizations/${uid(1101)}`, 'Vaccine - Influenza, seasonal, injectable'],
    ['/portal/patient-documents', 'Patient Documents'],
    ['/portal/reports', 'Patient Health Report'],
    ['/portal/document-templates', 'Document Template'],
    [`/portal/document-templates/${uid(1601)}`, 'Patient Intake Form'],
    ['/portal/appointments', 'My Appointments'],
    ['/portal/appointments/schedule', 'Schedule an appointment'],
    [`/portal/appointments/${uid(501)}`, 'Upcoming Visit Details'],
    [`/portal/appointments/${uid(501)}/reschedule`, 'Reschedule an appointment'],
    [`/portal/visit-summaries/${uid(601)}`, 'Visit Summary'],
    ['/portal/messages/inbox', 'Inbox Messages'],
    ['/portal/messages/sent', 'Sent Messages'],
    ['/portal/messages/trash', 'Trash Messages'],
    ['/portal/messages/compose', 'Compose Messages'],
    ['/portal/prescriptions', 'Prescriptions'],
    ['/portal/billing', 'Pay Bills'],
    ['/portal/video-consult', 'Video Consulting'],
    ['/portal/patient-education', 'Patient Education'],
    ['/portal/demographics', 'Demographics and Profile Information'],
    ['/portal/e-signature', 'Patient Electronic Signature'],
    ['/portal/change-password', 'Change Password'],
    ['/portal/nowhere', 'Page not found'],
  ] as const

  it.each(pages)('%s has no axe violations', async (path, heading) => {
    await signIn(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    await loaded()
    expect(await axeViolations()).toEqual([])
  })

  it.each([
    ['/portal/register', 'Registration Form'],
    ['/portal/forgot-username', 'Username Recovery'],
    ['/portal/forgot-password', 'Need help with your password?'],
  ])('signed-out page %s has no axe violations', async (path, heading) => {
    renderPortal(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    await loaded()
    expect(await axeViolations()).toEqual([])
  })
})
