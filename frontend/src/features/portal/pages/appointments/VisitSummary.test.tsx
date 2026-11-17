import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../../api/client'
import type { PortalAppointment, PortalVisitSummary } from '../../../../api/generated/model'
import { axeViolations } from '../../../../test/axe'
import { PortalApiContext, type PortalApi } from '../../api/portalApi'
import { ClinicZone } from '../../clinicZone'
import { PortalRouter } from '../../router'
import { AppointmentsPage, VisitSummaryPage } from './AppointmentPages'

// Previous visits and their visit summaries with the real API (#395: listPortalAppointments,
// getPortalVisitSummary, getPortalVisitSummaryDownloadUrl). Synthetic visits only; the API is a
// stand-in that answers the reads each page makes.

const SUMMARY_ID = '7a2b0000-0000-4000-8000-000000000001'

const summary = (over: Partial<PortalVisitSummary> = {}): PortalVisitSummary =>
  ({
    id: SUMMARY_ID,
    visitDate: '2026-09-29',
    providerDisplayName: 'Dr. Example Provider MD',
    facilityName: 'Example Clinic (synthetic)',
    releaseStatus: 'available',
    availableAt: '2026-09-29T17:15:00Z',
    ...over,
  }) as PortalVisitSummary

const past = (over: Partial<PortalAppointment> = {}): PortalAppointment =>
  ({
    id: '7a2b0000-0000-4000-8000-0000000000a1',
    startAt: '2026-09-29T16:30:00Z',
    timeZone: 'America/Los_Angeles',
    status: 'fulfilled',
    provider: { id: 'p1', displayName: 'Dr. Example Provider MD' },
    facility: { id: 'f1', name: 'Example Clinic (synthetic)' },
    telehealth: false,
    visitSummaryId: SUMMARY_ID,
    ...over,
  }) as unknown as PortalAppointment

function renderWith(api: Partial<PortalApi>, page: React.ReactNode) {
  const full = { listBookingFacilities: () => Promise.resolve([{ timeZone: 'America/Los_Angeles' }]), ...api } as unknown as PortalApi
  render(
    <PortalApiContext.Provider value={full}>
      <PortalRouter>
        <ClinicZone>{page}</ClinicZone>
      </PortalRouter>
    </PortalApiContext.Provider>,
  )
  return full
}

const notFound = () => new ApiError({ type: 'about:blank', title: 'Not found', status: 404, code: 'not-found', requestId: 'r' } as never)

describe('Previous visits with the real API', () => {
  it('marks a past visit that has a summary, and opens it from the tile', async () => {
    renderWith({ listAppointments: (when) => Promise.resolve(when === 'past' ? [past(), ({ ...past({ id: 'x2', startAt: '2026-06-02T16:30:00Z' }), visitSummaryId: undefined }) as unknown as PortalAppointment] : []) }, <AppointmentsPage />)
    const heading = await screen.findByRole('heading', { name: 'Past Appointments' })
    const links = within(heading.parentElement as HTMLElement).getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', `/portal/visit-summaries/${SUMMARY_ID}`)
    expect(links[0]).toHaveTextContent('Visit summary')
    // A past visit without a summary keeps its details link and no summary marker.
    expect(links[1]).not.toHaveTextContent('Visit summary')
    expect(await axeViolations()).toEqual([])
  })
})

describe('The visit summary with the real API', () => {
  it('shows the visit and offers the download for an available summary', async () => {
    renderWith({ getVisitSummary: () => Promise.resolve(summary()) }, <VisitSummaryPage visitSummaryId={SUMMARY_ID} />)
    expect(await screen.findByText('09/29/2026')).toBeInTheDocument()
    expect(screen.getByText('Dr. Example Provider MD')).toBeInTheDocument()
    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open visit summary' })).toBeInTheDocument()
  })

  it('shows a held summary as held, with no download', async () => {
    renderWith({ getVisitSummary: () => Promise.resolve(summary({ releaseStatus: 'held' })) }, <VisitSummaryPage visitSummaryId={SUMMARY_ID} />)
    expect(await screen.findByText(/Held by your clinician/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open visit summary' })).toBeNull()
  })

  it('opens the one-time link in a new tab, and never keeps it', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderWith(
      { getVisitSummary: () => Promise.resolve(summary()), getVisitSummaryDownloadUrl: () => Promise.resolve({ url: '/api/v1/portal/me/files/f1/content?token=t', expiresAt: '2026-09-29T18:00:00Z' } as never) },
      <VisitSummaryPage visitSummaryId={SUMMARY_ID} />,
    )
    await user.click(await screen.findByRole('button', { name: 'Open visit summary' }))
    expect(open).toHaveBeenCalledWith('/api/v1/portal/me/files/f1/content?token=t', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('says plainly that the summary cannot be downloaded yet when there is no link (404), not that the record is missing', async () => {
    const user = userEvent.setup()
    renderWith({ getVisitSummary: () => Promise.resolve(summary()), getVisitSummaryDownloadUrl: () => Promise.reject(notFound()) }, <VisitSummaryPage visitSummaryId={SUMMARY_ID} />)
    await user.click(await screen.findByRole('button', { name: 'Open visit summary' }))
    expect(await screen.findByText("This summary can't be downloaded yet")).toBeInTheDocument()
    expect(screen.getByText('Ask your clinic for a copy of your visit summary.')).toBeInTheDocument()
    expect(screen.queryByText(/removed/)).toBeNull()
  })

  it("shows the portal's error with Try again, and no sample data, when the summary can't be read", async () => {
    const user = userEvent.setup()
    let calls = 0
    const api = renderWith(
      {
        getVisitSummary: vi.fn(() => {
          calls += 1
          return calls === 1
            ? Promise.reject(new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503, code: 'service-unavailable', requestId: 'r' } as never))
            : Promise.resolve(summary())
        }),
      },
      <VisitSummaryPage visitSummaryId={SUMMARY_ID} />,
    )
    expect(await screen.findByText("Couldn't load the visit summary")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('09/29/2026')).toBeInTheDocument()
    expect(api.getVisitSummary).toHaveBeenCalledTimes(2)
  })
})
