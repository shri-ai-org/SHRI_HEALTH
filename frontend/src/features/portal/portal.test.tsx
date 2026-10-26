import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { createMockPortalApi, MOCK_INVITATION_CODE, uid } from './api/mockPortalApi'
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

/** "Sign in" stands for a completed sign-in at the patient realm (D85); no password is typed here. */
async function signIn(path = '/portal') {
  const user = userEvent.setup()
  renderPortal(path)
  await user.click(await screen.findByRole('button', { name: 'Sign in' }))
  return user
}

async function loaded() {
  await waitFor(() => expect(screen.queryByText(/^Loading/)).toBeNull())
}

describe('sign-in', () => {
  it('starts sign-in at the patient realm: no password, registration or recovery here (D85)', async () => {
    renderPortal()
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/Password|Username/)).toBeNull()
    expect(screen.queryByRole('link', { name: /Registration|Forgot/ })).toBeNull()
    expect(screen.getByText(/Ask your clinic's front desk for an invitation code/)).toBeInTheDocument()
    // D87: a fixed path on the portal host, with no version or commit in it.
    expect(screen.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', '/source.tar.gz')
    expect(await axeViolations()).toEqual([])
  })

  it('sends the old registration and recovery addresses to sign-in', async () => {
    for (const path of ['/portal/register', '/portal/forgot-username', '/portal/forgot-password']) {
      const { unmount } = render(<ToastProvider><PortalApp api={createMockPortalApi({ latencyMs: 0 })} /></ToastProvider>)
      window.history.replaceState(null, '', path)
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
      unmount()
    }
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
    expect(within(account).getAllByRole('link').map((l) => l.textContent)).toEqual(['Demographics', 'E-Signature', 'Password and security'])
    // Password, multi-factor and recovery are the patient realm's own pages (D85).
    expect(within(account).getByRole('link', { name: 'Password and security' })).toHaveAttribute('href', expect.stringContaining('/realms/patients/account'))
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
    await user.selectOptions(screen.getByLabelText(/Your providers/), 'Dr. Alvina56 Hettinger94, MD')
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
    await user.selectOptions(await screen.findByLabelText(/^To/), 'Dr. Alvina56 Hettinger94, MD')
    await user.selectOptions(screen.getByLabelText(/^Subject/), 'Non Urgent Medical Question')
    await user.type(screen.getByLabelText(/^Message/), 'I felt dizzy this morning.')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Message sent successfully.')).toBeInTheDocument()
  })

  it('opens a message, moves it to trash, then deletes it after confirming', async () => {
    const user = await signIn('/portal/messages/inbox')
    await user.click(await screen.findByRole('button', { name: 'Non Urgent Medical Question' }))
    const reader = await screen.findByRole('dialog', { name: 'Inbox' })
    expect(reader).toHaveTextContent('Dr. Alvina56 Hettinger94, MD')
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

describe('set up your account, before any sign-in (D85, ADR-0013 §3)', () => {
  async function toSetUp() {
    const user = userEvent.setup()
    renderPortal()
    await user.click(await screen.findByRole('link', { name: 'Set up your account' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up your account' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/portal/set-up-account')
    return user
  }

  async function fill(user: ReturnType<typeof userEvent.setup>, code: string, birthDate: string) {
    await user.clear(screen.getByLabelText(/Invitation code/))
    await user.type(screen.getByLabelText(/Invitation code/), code)
    await user.clear(screen.getByLabelText(/Date of birth/))
    await user.type(screen.getByLabelText(/Date of birth/), birthDate)
    await user.clear(screen.getByLabelText(/Email address/))
    await user.type(screen.getByLabelText(/Email address/), 'ramona980@example.com')
    await user.click(screen.getByRole('button', { name: 'Set up my account' }))
  }

  it('asks for the code, date of birth and email, signed out', async () => {
    const user = await toSetUp()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Source code' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Set up my account' }))
    expect(screen.getByRole('alert')).toHaveTextContent('There are 3 things to fix')
  })

  it('gives the same answer for a wrong code or a wrong date of birth', async () => {
    const user = await toSetUp()
    for (const [code, birthDate] of [['WRONG-0000', '07/19/1984'], [MOCK_INVITATION_CODE, '01/01/1990']] as const) {
      await fill(user, code, birthDate)
      await waitFor(() => expect(screen.getByLabelText(/Invitation code/)).toHaveAccessibleDescription(/We couldn't use that code/))
    }
  })

  it('sends the patient to their email, then to sign-in', async () => {
    const user = await toSetUp()
    await fill(user, MOCK_INVITATION_CODE.toLowerCase(), '07/19/1984')
    expect(await screen.findByRole('heading', { level: 1, name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByText(/within 12 hours/)).toBeInTheDocument()
    // The email typed is not shown back.
    expect(screen.queryByText(/ramona980@example\.com/)).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Go to sign in' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
  })
})

describe('portal shell', () => {
  it('offers the source code on every signed-in page (D87)', async () => {
    await signIn()
    await screen.findByRole('region', { name: 'Alerts and Reminders' })
    expect(screen.getByRole('contentinfo')).toContainElement(screen.getByRole('link', { name: 'Source code' }))
  })

  it('shows record dates as MM/DD/YYYY', async () => {
    await signIn(`/portal/immunizations/${uid(1101)}`)
    await screen.findByRole('heading', { level: 1, name: 'Vaccine - Influenza, seasonal, injectable' })
    await loaded()
    expect(screen.getByText('Date Administered').nextElementSibling?.textContent).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
  })

  it('has no Change Password page any more', async () => {
    await signIn('/portal/change-password')
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
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
    ['/portal/nowhere', 'Page not found'],
  ] as const

  it.each(pages)('%s has no axe violations', async (path, heading) => {
    await signIn(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    await loaded()
    expect(await axeViolations()).toEqual([])
  })

  it.each([['/portal/sign-in', 'Sign in']])('signed-out page %s has no axe violations', async (path, heading) => {
    renderPortal(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    await loaded()
    expect(await axeViolations()).toEqual([])
  })
})
