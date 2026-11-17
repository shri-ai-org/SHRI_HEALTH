import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../api/client'
import type { PortalMedication } from '../../../api/generated/model'
import { axeViolations } from '../../../test/axe'
import { PortalApiContext, type PortalApi } from '../api/portalApi'
import { ClinicZone } from '../clinicZone'
import { PortalRouter } from '../router'
import { MedicationsPage } from './PrescriptionPages'

// The patient's own medication list with the real API (listPortalMedications, #389). Synthetic
// medications only; the API is a stand-in that answers the two reads the page makes.

const med = (over: Partial<PortalMedication>): PortalMedication => ({
  id: 'b1d0c7a2-1111-4aaa-8bbb-000000000001',
  display: 'lisinopril 10 MG Oral Tablet',
  dosageText: '1 tablet by mouth once daily',
  status: 'active',
  source: 'prescription',
  ...over,
})

function setup(listMedications: () => Promise<PortalMedication[]>) {
  const api = {
    listMedications: vi.fn(listMedications),
    listBookingFacilities: () => Promise.resolve([{ timeZone: 'America/Los_Angeles' }]),
  } as unknown as PortalApi
  render(
    <PortalApiContext.Provider value={api}>
      <PortalRouter>
        <ClinicZone>
          <MedicationsPage />
        </ClinicZone>
      </PortalRouter>
    </PortalApiContext.Provider>,
  )
  return api
}

describe('Prescriptions with the real API', () => {
  it('lists each medication with its directions, status and source, and who prescribed it when', async () => {
    setup(() =>
      Promise.resolve([
        // 2026-10-27T20:30Z is Oct 27 in San Jose.
        med({ prescribedAt: '2026-10-27T20:30:00Z', prescriberDisplayName: 'Dr. Example Provider MD', pharmacyName: 'Example Pharmacy (synthetic)', transmissionStatus: 'accepted' }),
        { id: 'b1d0c7a2-1111-4aaa-8bbb-000000000002', display: 'acetaminophen 500 MG Oral Tablet', status: 'stopped', source: 'reported' },
      ]),
    )
    const list = await screen.findByRole('list', { name: 'Your medications' })
    const [first, second] = within(list).getAllByRole('listitem')
    expect(first).toHaveTextContent('lisinopril 10 MG Oral Tablet')
    expect(first).toHaveTextContent('1 tablet by mouth once daily')
    expect(first).toHaveTextContent('Active')
    expect(first).toHaveTextContent('Prescribed by Dr. Example Provider MD on 10/27/2026')
    expect(first).toHaveTextContent('Pharmacy: Example Pharmacy (synthetic) · Received by the pharmacy')
    expect(second).toHaveTextContent('Stopped')
    expect(second).toHaveTextContent('Reported by you')
    // No prescriber, pharmacy or transmission: no empty labels.
    expect(second).not.toHaveTextContent('Prescribed by Dr.')
    expect(second).not.toHaveTextContent('Pharmacy:')
    expect(screen.getByText('To request a refill, contact your clinic.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /refill/i })).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('says so when there are none', async () => {
    setup(() => Promise.resolve([]))
    expect(await screen.findByText('No medications on your record yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Your medications' })).toBeNull()
  })

  it("shows the portal's error with Try again, and no sample data, when the read fails", async () => {
    const user = userEvent.setup()
    let calls = 0
    const api = setup(() => {
      calls += 1
      return calls === 1
        ? Promise.reject(new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503, code: 'service-unavailable', requestId: 'req-503' } as never))
        : Promise.resolve([med({})])
    })
    expect(await screen.findByText("Couldn't load your medications")).toBeInTheDocument()
    expect(screen.queryByText('lisinopril 10 MG Oral Tablet')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('lisinopril 10 MG Oral Tablet')).toBeInTheDocument()
    expect(api.listMedications).toHaveBeenCalledTimes(2)
  })
})
