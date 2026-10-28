import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setCsrfToken } from '../../api/client'
import { ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { createHttpPortalApi } from './api/httpPortalApi'
import { createMockPortalApi, uid } from './api/mockPortalApi'
import type { PortalApi } from './api/portalApi'
import { PortalApp } from './PortalApp'
import { BIRTH_DATE, fakePortalServer, IDS, INVITATION_CODE, type FakeOptions } from './test/fakePortalServer'

// Synthetic data only (fakePortalServer for B8a, mockPortalApi for the later screens).

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

function setup(path = '/portal', options: FakeOptions = {}) {
  const server = fakePortalServer(options)
  const startSignIn = vi.fn()
  const api: PortalApi = { ...createHttpPortalApi(createMockPortalApi({ latencyMs: 0 })), startSignIn }
  window.history.replaceState(null, '', path)
  const user = userEvent.setup()
  render(
    <ToastProvider>
      <PortalApp api={api} />
    </ToastProvider>,
  )
  return { server, user, startSignIn }
}

async function loaded() {
  await waitFor(() => expect(screen.queryByText(/^Loading/)).toBeNull())
}

/** A weekday about two weeks out, as MM/DD/YYYY and YYYY-MM-DD. */
function futureWeekday() {
  const d = new Date(Date.now() + 14 * 86_400_000)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return { us: `${mm}/${dd}/${d.getFullYear()}`, iso: `${d.getFullYear()}-${mm}-${dd}` }
}

describe('sign-in', () => {
  it('starts sign-in at the patient realm: no password, registration or recovery here (D85)', async () => {
    const { user, startSignIn } = setup('/portal', { signedIn: false })
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/Password|Username/)).toBeNull()
    expect(screen.queryByRole('link', { name: /Registration|Forgot/ })).toBeNull()
    expect(screen.getByText(/Ask your clinic's front desk for an invitation code/)).toBeInTheDocument()
    // D87: a fixed path on the portal host, with no version or commit in it.
    expect(screen.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', '/source.tar.gz')
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(startSignIn).toHaveBeenCalledOnce()
  })

  it('sends the old registration and recovery addresses to sign-in', async () => {
    for (const path of ['/portal/register', '/portal/forgot-username', '/portal/forgot-password']) {
      setup(path, { signedIn: false })
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
      document.body.innerHTML = ''
    }
  })

  it('reads the session without extending it, and keeps its CSRF token for writes (ADR-0013 §5)', async () => {
    const { server, user } = setup(`/portal/appointments/${IDS.upcoming}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Upcoming Visit Details' })).toBeInTheDocument()
    expect(server.to('GET', '/portal/auth/session')).toHaveLength(1)
    expect(server.to('POST', '/portal/auth/refresh')).toHaveLength(0)
    await user.click(await screen.findByRole('button', { name: 'Cancel Appointment' }))
    await user.type(screen.getByLabelText(/Reason for canceling/), 'Feeling better.')
    await user.click(screen.getByRole('button', { name: 'Cancel appointment' }))
    await screen.findByText('Your appointment is canceled')
    expect(server.to('POST', `/portal/me/appointments/${IDS.upcoming}/cancel`)[0]?.headers.get('X-CSRF-Token')).toBe('test-csrf-token')
  })

  it('shows sign-in again when the server ends the session', async () => {
    setup('/portal/demographics', { unauthorized: ['/portal/me'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    // A 401 can mean a disabled account or a session ended elsewhere, so the message names no cause.
    expect(screen.getByText('Your session has ended. Please sign in again.')).toBeInTheDocument()
    expect(screen.queryByText(/15 minutes without activity/)).toBeNull()
  })
})

describe('home and menus', () => {
  it('greets the patient and shows the cards and the alerts from upcoming appointments', async () => {
    const { server } = setup()
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome, Ramona' })).toBeInTheDocument()
    for (const card of ['Test Results', 'Health Summary', 'Appointments', 'Messages', 'Prescriptions', 'Patient Education']) {
      expect(screen.getAllByRole('link', { name: new RegExp(`^${card}`) }).length).toBeGreaterThan(0)
    }
    const alerts = await screen.findByRole('region', { name: 'Alerts and Reminders' })
    expect(await within(alerts).findAllByText(/You have an appointment on|Today at/)).toHaveLength(1)
    expect(server.to('GET', '/portal/me/appointments')[0]?.query.get('when')).toBe('upcoming')
    expect(await axeViolations()).toEqual([])
  })

  it('keeps Pay bills, Video and Immunizations hidden until their contracts exist', async () => {
    const { user } = setup()
    await screen.findByRole('region', { name: 'Alerts and Reminders' })
    expect(screen.queryByRole('link', { name: /^Billing|^Video Consult/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Health Summary/ }))
    const menu = document.getElementById('health-menu')
    if (!menu) throw new Error('no health menu')
    expect(within(menu).getAllByRole('link').map((l) => l.textContent)).toEqual(['Health Issues', 'Health Trends', 'Allergies', 'Patient Documents', 'Reports', 'Document Template'])
  })

  it.each(['/billing', '/video-consult', '/immunizations'])('has no page at %s while it is switched off', async (path) => {
    setup(`/portal${path}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
  })

  it('has the account menu items', async () => {
    const { user } = setup()
    await screen.findByRole('region', { name: 'Alerts and Reminders' })
    await user.click(screen.getByRole('button', { name: /account menu/ }))
    const account = document.getElementById('account-menu')
    if (!account) throw new Error('no account menu')
    expect(within(account).getAllByRole('link').map((l) => l.textContent)).toEqual(['Demographics', 'E-Signature', 'Password and security'])
    // Password, multi-factor and recovery are the patient realm's own pages (D85).
    expect(within(account).getByRole('link', { name: 'Password and security' })).toHaveAttribute('href', '/kc/realms/shri-patients/account')
    expect(within(account).getByRole('button', { name: 'Log out' })).toBeInTheDocument()
  })
})

describe('health records (B8a)', () => {
  it('lists a held problem without its content or a link (D90)', async () => {
    const { user } = setup('/portal/health-issues')
    const table = await screen.findByRole('table', { name: 'Medical problems' })
    expect(within(table).getByText(/Held by your clinician/)).toBeInTheDocument()
    expect(within(table).getAllByRole('link')).toHaveLength(1)
    await user.click(within(table).getByRole('link', { name: 'Essential hypertension' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Essential hypertension - Problem' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/portal/health-issues/${IDS.problem}`)
  })

  it('shows nothing of a held problem even if the server sends its content (D90)', async () => {
    setup('/portal/health-issues', { heldProblemLeaks: true })
    const table = await screen.findByRole('table', { name: 'Medical problems' })
    const held = within(table).getByText(/Held by your clinician/).closest('tr')
    if (!held) throw new Error('no held row')
    expect(held).not.toHaveTextContent(/Secret diagnosis|Came back|09\/2026/)
    expect(within(held).getAllByText('—')).toHaveLength(2)
  })

  it('shows allergies with their reactions and risk', async () => {
    const { user } = setup('/portal/allergies')
    const row = await screen.findByRole('row', { name: /Penicillin/ })
    expect(row).toHaveTextContent('Hives')
    await user.click(within(row).getByRole('link', { name: 'Penicillin' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Allergy - Penicillin' })).toBeInTheDocument()
    expect(screen.getByText('High risk')).toBeInTheDocument()
    // Record dates read MM/DD/YYYY.
    expect(screen.getByText('Recorded').nextElementSibling?.textContent).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
  })

  it('groups vitals measured together into one visit', async () => {
    const { user } = setup('/portal/health-trends')
    await screen.findByRole('heading', { level: 1, name: 'Health Trends' })
    await user.click(await screen.findByRole('button', { name: 'List' }))
    const table = await screen.findByRole('table', { name: 'Vitals by visit' })
    expect(within(table).getByRole('row', { name: /Blood Pressure/ })).toHaveTextContent('131/84 mmHg')
    expect(within(table).getByRole('row', { name: /Pulse/ })).toHaveTextContent('70 /min')
  })

  it('opens an available visit summary through a short-lived link, and shows a held one as held (D86)', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { user } = setup(`/portal/visit-summaries/${IDS.summary}`)
    await user.click(await screen.findByRole('button', { name: 'Open visit summary' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.stringContaining(`/visit-summary/${IDS.summary}`), '_blank', 'noopener,noreferrer'))
    open.mockRestore()
  })

  it('shows a held visit summary without an open button', async () => {
    setup(`/portal/visit-summaries/${IDS.heldSummary}`)
    expect(await screen.findByText(/Held by your clinician/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open visit summary' })).toBeNull()
  })
})

describe('records still on the mock (B8b)', () => {
  it('opens a result detail by ID, so refresh and links work', async () => {
    const { user } = setup('/portal/test-results')
    await user.click(await screen.findByRole('link', { name: 'Basic metabolic panel' }))
    expect(await screen.findByRole('heading', { level: 1, name: '80048 - Basic metabolic panel - Details' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/portal/test-results/${uid(801)}`)
    expect(screen.getByRole('row', { name: /Potassium/ })).toHaveTextContent('High')
  })
})

describe('prescriptions', () => {
  it('sends a refill and shows the summary with the chosen pharmacy', async () => {
    const { user } = setup('/portal/prescriptions')
    await user.click(await screen.findByRole('checkbox', { name: /Select Lisinopril/ }))
    await user.selectOptions(screen.getByLabelText(/Choose your convenient pharmacy/), 'Placeholder Drug Co.')
    await user.type(screen.getByLabelText(/Message for your provider/), 'Running low, thank you.')
    await user.click(screen.getByRole('button', { name: 'Send Refill Request' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Prescription Refill Summary' })).toBeInTheDocument()
    expect(screen.getByText(/Lisinopril 10 mg tablet/)).toBeInTheDocument()
    expect(screen.getByText(/Placeholder Drug Co\./)).toBeInTheDocument()
  })

  it('asks for a prescription, pharmacy and message first', async () => {
    const { user } = setup('/portal/prescriptions')
    await user.click(await screen.findByRole('button', { name: 'Send Refill Request' }))
    expect(screen.getByRole('alert')).toHaveTextContent('There are 3 things to fix')
  })
})

describe('appointments (B8a)', () => {
  async function fillBooking(user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(await screen.findByLabelText(/Select a location/), 'Shri Health Springfield Clinic')
    await waitFor(() => expect(screen.getByLabelText(/Select appointment type/)).toBeEnabled())
    await user.selectOptions(screen.getByLabelText(/Select appointment type/), 'Office Visit (20 min)')
    await user.selectOptions(screen.getByLabelText(/Select reason for visit/), 'Annual Physical')
    await waitFor(() => expect(screen.getByLabelText(/Your providers/)).toBeEnabled())
    await user.selectOptions(screen.getByLabelText(/Your providers/), 'Dr. Alvina56 Hettinger94, MD, Internal medicine')
    await user.type(screen.getByLabelText(/Appointment preferred date/), futureWeekday().us)
  }

  async function pickFirstTime(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /Preferred time/ }))
    const picker = await screen.findByRole('dialog', { name: 'Select preferred timing' })
    const first = (await within(picker).findAllByRole('button', { name: /AM|PM/ }))[0]
    if (!first) throw new Error('no open times')
    await user.click(first)
  }

  it('books through location, type, provider and the free times, with one key per chosen time', async () => {
    const { server, user } = setup('/portal/appointments/schedule')
    await fillBooking(user)
    await pickFirstTime(user)
    expect(server.to('GET', '/portal/me/slots')[0]?.query.get('date')).toBe(futureWeekday().iso)
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(await screen.findByText(/Appointment is scheduled successfully on/)).toBeInTheDocument()
    const [book] = server.to('POST', '/portal/me/appointments')
    expect(book?.body).toEqual({ facilityId: IDS.facility, appointmentTypeId: IDS.officeVisit, providerId: IDS.provider, startAt: `${futureWeekday().iso}T15:00:00.000Z`, reasonForVisit: 'Annual Physical' })
    expect(book?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reads the free times again when the chosen time was just taken', async () => {
    const { server, user } = setup('/portal/appointments/schedule', { bookingConflict: true })
    await fillBooking(user)
    await pickFirstTime(user)
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(await screen.findByText(/That time was just taken/)).toBeInTheDocument()
    const reads = server.slotReads()
    await pickFirstTime(user)
    expect(server.slotReads()).toBe(reads + 1)
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(await screen.findByText(/Appointment is scheduled successfully on/)).toBeInTheDocument()
    const keys = server.to('POST', '/portal/me/appointments').map((c) => c.headers.get('Idempotency-Key'))
    expect(new Set(keys).size).toBe(2)
  })

  it('cancels only with a reason, which goes to the clinic', async () => {
    const { server, user } = setup(`/portal/appointments/${IDS.upcoming}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel Appointment' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }))
    expect(within(dialog).getByLabelText(/Reason for canceling/)).toHaveAccessibleDescription(/Tell us why you are canceling/)
    expect(server.to('POST', `/portal/me/appointments/${IDS.upcoming}/cancel`)).toHaveLength(0)
    await user.type(within(dialog).getByLabelText(/Reason for canceling/), 'Feeling better.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'My Appointments' })).toBeInTheDocument()
    expect(await screen.findByText('Your appointment is canceled')).toBeInTheDocument()
    expect(server.to('POST', `/portal/me/appointments/${IDS.upcoming}/cancel`)[0]?.body).toEqual({ reasonText: 'Feeling better.' })
  })

  it('opens a past visit at its summary', async () => {
    const { user } = setup('/portal/appointments')
    const past = await screen.findByRole('region', { name: 'Past Appointments' })
    await user.click(within(past).getByRole('link', { name: /Dr\. Alvina56/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Visit Summary' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/portal/visit-summaries/${IDS.summary}`)
  })
})

describe('demographics as change requests (D91)', () => {
  it('sends only what changed, then shows it as waiting for the front desk', async () => {
    const { server, user } = setup('/portal/demographics')
    const city = await screen.findByLabelText(/^City/)
    await user.clear(city)
    await user.type(city, 'Chatham')
    await user.type(screen.getByLabelText(/Note for the front desk/), 'We moved in October.')
    await user.click(screen.getByRole('button', { name: 'Send changes' }))
    expect(await screen.findByText(/Sent to the front desk/)).toBeInTheDocument()
    const [sent] = server.to('POST', '/portal/me/change-requests')
    expect(sent?.body).toEqual({
      changes: { address: { lines: ['48 Placeholder St'], city: 'Chatham', state: 'IL', postalCode: '62704', country: 'US' } },
      note: 'We moved in October.',
    })
    expect(sent?.headers.get('Idempotency-Key')).toBeTruthy()
    expect(await screen.findByText(/You have a change waiting for the front desk/)).toBeInTheDocument()
    expect(screen.getByText(/: address$/)).toBeInTheDocument()
  })

  it('sends nothing when nothing changed', async () => {
    const { server, user } = setup('/portal/demographics')
    await user.click(await screen.findByRole('button', { name: 'Send changes' }))
    expect(await screen.findByText('Nothing has changed yet.')).toBeInTheDocument()
    expect(server.to('POST', '/portal/me/change-requests')).toHaveLength(0)
  })

  it('sends a cleared field as a line in the note, with another change', async () => {
    const { server, user } = setup('/portal/demographics')
    await user.selectOptions(await screen.findByLabelText(/Preferred language/), '')
    const city = screen.getByLabelText(/^City/)
    await user.clear(city)
    await user.type(city, 'Chatham')
    await user.click(screen.getByRole('button', { name: 'Send changes' }))
    expect(await screen.findByText(/Sent to the front desk/)).toBeInTheDocument()
    const [sent] = server.to('POST', '/portal/me/change-requests')
    expect(sent?.body).toEqual({
      changes: { address: { lines: ['48 Placeholder St'], city: 'Chatham', state: 'IL', postalCode: '62704', country: 'US' } },
      note: 'Please also remove my preferred language.',
    })
  })

  it('asks the patient to raise a removal with the front desk when nothing else changed', async () => {
    const { server, user } = setup('/portal/demographics')
    await user.selectOptions(await screen.findByLabelText(/Marital Status/), '')
    await user.click(screen.getByRole('button', { name: 'Send changes' }))
    expect(screen.getByLabelText(/Marital Status/)).toHaveAccessibleDescription(/To remove your marital status, ask the front desk/)
    expect(server.to('POST', '/portal/me/change-requests')).toHaveLength(0)
  })
})

describe('messages', () => {
  it('composes and sends a message', async () => {
    const { user } = setup('/portal/messages/compose')
    await user.selectOptions(await screen.findByLabelText(/^To/), 'Dr. Alvina56 Hettinger94, MD')
    await user.selectOptions(screen.getByLabelText(/^Subject/), 'Non Urgent Medical Question')
    await user.type(screen.getByLabelText(/^Message/), 'I felt dizzy this morning.')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Message sent successfully.')).toBeInTheDocument()
  })

  it('opens a message, moves it to trash, then deletes it after confirming', async () => {
    const { user } = setup('/portal/messages/inbox')
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

describe('documents', () => {
  it('will not send a document template for review before it is signed', async () => {
    const { user } = setup(`/portal/document-templates/${uid(1601)}`)
    await user.type(await screen.findByLabelText('Main reason for your visit'), 'Blood pressure check')
    await user.click(screen.getByRole('button', { name: 'Review' }))
    expect(await screen.findByText('Sign the document before sending it for review.')).toBeInTheDocument()
  })
})

describe('set up your account, before any sign-in (D85, ADR-0013 §3)', () => {
  async function toSetUp() {
    const s = setup('/portal', { signedIn: false })
    await s.user.click(await screen.findByRole('link', { name: 'Set up your account' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up your account' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/portal/set-up-account')
    return s
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
    const { user } = await toSetUp()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Source code' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Set up my account' }))
    expect(screen.getByRole('alert')).toHaveTextContent('There are 3 things to fix')
  })

  it('gives the same answer for a wrong code or a wrong date of birth', async () => {
    const { user } = await toSetUp()
    for (const [code, birthDate] of [['WRONG-0000-0000', '07/19/1984'], [INVITATION_CODE, '01/01/1990']] as const) {
      await fill(user, code, birthDate)
      await waitFor(() => expect(screen.getByLabelText(/Invitation code/)).toHaveAccessibleDescription(/We couldn't use that code/))
    }
  })

  it('sends the patient to their email, then to sign-in', async () => {
    const { server, user } = await toSetUp()
    await fill(user, INVITATION_CODE.toLowerCase(), '07/19/1984')
    expect(await screen.findByRole('heading', { level: 1, name: 'Check your email' })).toBeInTheDocument()
    const [enroll] = server.to('POST', '/portal/enrollments')
    expect(enroll?.body).toEqual({ invitationCode: INVITATION_CODE.toLowerCase(), birthDate: BIRTH_DATE, email: 'ramona980@example.com' })
    expect(enroll?.headers.get('Idempotency-Key')).toBeTruthy()
    expect(screen.getByText(/within 12 hours/)).toBeInTheDocument()
    // The email typed is not shown back.
    expect(screen.queryByText(/ramona980@example\.com/)).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Go to sign in' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
  })
})

describe('portal shell', () => {
  it('offers the source code on every signed-in page (D87)', async () => {
    setup()
    await screen.findByRole('region', { name: 'Alerts and Reminders' })
    expect(screen.getByRole('contentinfo')).toContainElement(screen.getByRole('link', { name: 'Source code' }))
  })

  it('has no Change Password page any more', async () => {
    setup('/portal/change-password')
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
  })
})

describe('accessibility of every page', () => {
  const pages = [
    ['/portal/test-results', 'Test Results'],
    [`/portal/test-results/${uid(801)}`, '80048 - Basic metabolic panel - Details'],
    ['/portal/health-issues', 'Medical Problems'],
    [`/portal/health-issues/${IDS.problem}`, 'Essential hypertension - Problem'],
    ['/portal/health-trends', 'Health Trends'],
    ['/portal/allergies', 'Allergies'],
    [`/portal/allergies/${IDS.allergy}`, 'Allergy - Penicillin'],
    ['/portal/patient-documents', 'Patient Documents'],
    ['/portal/reports', 'Patient Health Report'],
    ['/portal/document-templates', 'Document Template'],
    [`/portal/document-templates/${uid(1601)}`, 'Patient Intake Form'],
    ['/portal/appointments', 'My Appointments'],
    ['/portal/appointments/schedule', 'Schedule an appointment'],
    [`/portal/appointments/${IDS.upcoming}`, 'Upcoming Visit Details'],
    [`/portal/appointments/${IDS.upcoming}/reschedule`, 'Reschedule an appointment'],
    [`/portal/visit-summaries/${IDS.summary}`, 'Visit Summary'],
    ['/portal/messages/inbox', 'Inbox Messages'],
    ['/portal/messages/sent', 'Sent Messages'],
    ['/portal/messages/trash', 'Trash Messages'],
    ['/portal/messages/compose', 'Compose Messages'],
    ['/portal/prescriptions', 'Prescriptions'],
    ['/portal/patient-education', 'Patient Education'],
    ['/portal/demographics', 'Demographics and Profile Information'],
    ['/portal/e-signature', 'Patient Electronic Signature'],
    ['/portal/nowhere', 'Page not found'],
  ] as const

  it.each(pages)('%s has no axe violations', async (path, heading) => {
    setup(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    await loaded()
    expect(await axeViolations()).toEqual([])
  })

  it.each([['/portal/sign-in', 'Sign in']])('signed-out page %s has no axe violations', async (path, heading) => {
    setup(path, { signedIn: false })
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    await loaded()
    expect(await axeViolations()).toEqual([])
  })
})
