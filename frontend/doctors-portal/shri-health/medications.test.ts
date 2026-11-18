import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listMedications } from '../../src/api/generated/endpoints/medications/medications'
import { useActiveMedicationCount } from './medications'

vi.mock('../../src/api/generated/endpoints/medications/medications', () => ({ listMedications: vi.fn() }))

// The record's Prescriptions tab count (audit issue 6): the server's, never the sample's. Synthetic only.
const med = (id: string, status: string) => ({
  id,
  medication: { text: 'omeprazole 20 MG Delayed Release Oral Capsule' },
  status,
  source: 'prescription',
  recordedAt: '2026-09-29T17:00:00Z',
})

beforeEach(() => vi.mocked(listMedications).mockReset())

describe('the Prescriptions tab count', () => {
  it("counts the patient's active medications from the API", async () => {
    vi.mocked(listMedications).mockResolvedValue({
      status: 200,
      data: { items: [med('m1', 'active'), med('m2', 'active'), med('m3', 'stopped'), med('m4', 'entered-in-error')] },
    } as never)
    const { result } = renderHook(() => useActiveMedicationCount('p-1'))
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe(2))
  })

  it('shows no count when the read fails', async () => {
    // A read that fails inside the loader (here an answer without its list), as a refused or broken
    // read does: the tab shows no count, never the sample's.
    vi.mocked(listMedications).mockResolvedValue({ status: 200, data: {} } as never)
    const { result } = renderHook(() => useActiveMedicationCount('p-1'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(listMedications).toHaveBeenCalledTimes(1)
    expect(result.current).toBeUndefined()
  })

  it('reads nothing without a patient (the sample screens)', () => {
    const { result } = renderHook(() => useActiveMedicationCount(''))
    expect(result.current).toBeUndefined()
    expect(listMedications).not.toHaveBeenCalled()
  })
})
