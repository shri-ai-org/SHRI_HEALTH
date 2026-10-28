import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../design-system'
import { json, serve } from '../../test/fakeServer'
import { PatientPage } from './PatientPage'

// A production build: the portal and its staff panel are switched off together (PORTAL_ENABLED).
vi.mock('../portal/features', async (original) => ({ ...(await original<typeof import('../portal/features')>()), PORTAL_ENABLED: false }))

// Synthetic data only.
const patient = {
  id: '00000000-0000-4000-8000-0000000000aa',
  name: { given: ['Ana'], family: 'Testperson' },
  birthDate: '1984-07-19',
  gender: 'female',
  mrn: 'SH-2001',
  active: true,
  createdAt: '2026-10-24T12:00:00Z',
  updatedAt: '2026-10-24T12:00:00Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PatientPage without the portal', () => {
  it('shows no Portal account panel and never calls the portal-account routes', async () => {
    // No portal-account route: the fake server fails any call to it.
    const server = serve({
      [`GET /api/v1/patients/${patient.id}`]: [() => json(200, patient)],
      [`GET /api/v1/patients/${patient.id}/coverages?limit=100`]: [() => json(200, { items: [] })],
      [`GET /api/v1/appointments?patientId=${patient.id}&limit=100`]: [() => json(200, { items: [] })],
      'GET /api/v1/booking/facilities?limit=100': [() => json(200, { items: [] })],
      'GET /api/v1/booking/appointment-types?limit=100': [() => json(200, { items: [] })],
    })
    const router = createMemoryRouter([{ path: '/patients/:patientId', element: <PatientPage /> }], { initialEntries: [`/patients/${patient.id}`] })
    render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Insurance' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Portal account' })).toBeNull()
    expect(server.calls().some((c) => c.includes('portal-account'))).toBe(false)
  })
})
