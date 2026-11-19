import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../src/api/client'
import { pharmacyText } from '../src/shri/logic/medicationDisplay'
import { forgetPharmacies, usePharmacyNames } from './prescribers'

// The record's Prescriptions page: each signed medicine's pharmacy from its prescription
// (getPrescription). A plain stand-in, not a vi.fn, so a refused lookup can reject. Synthetic only.
const answers: Record<string, () => Promise<unknown>> = {}
const asked: string[] = []
vi.mock('../../src/api/generated/endpoints/medications/medications', () => ({
  getPrescription: (id: string) => {
    asked.push(id)
    return answers[id]()
  },
}))

const atPharmacy = (name: string) => () => Promise.resolve({ status: 200, data: { id: 'rx', pharmacyName: name } })
const forbidden = () => Promise.reject(new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden' } as never, new Headers()))

beforeEach(() => {
  forgetPharmacies()
  asked.length = 0
})

describe('the pharmacy of each medicine', () => {
  it('names the pharmacy of each prescribed medicine, reading each prescription once, together', async () => {
    answers.rx1 = atPharmacy('Example Pharmacy (synthetic)')
    answers.rx2 = atPharmacy('Second Example Pharmacy (synthetic)')
    const { result } = renderHook(() => usePharmacyNames(['rx1', 'rx2', 'rx1']))
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2))
    expect(pharmacyText({ prescriptionId: 'rx1' }, result.current)).toBe('Pharmacy: Example Pharmacy (synthetic)')
    expect(pharmacyText({ prescriptionId: 'rx2' }, result.current)).toBe('Pharmacy: Second Example Pharmacy (synthetic)')
    expect(asked.sort()).toEqual(['rx1', 'rx2'])
  })

  it('keeps a pharmacy read for the page: opening it again asks nothing more', async () => {
    answers.rx1 = atPharmacy('Example Pharmacy (synthetic)')
    const first = renderHook(() => usePharmacyNames(['rx1']))
    await waitFor(() => expect(first.result.current.rx1).toBe('Example Pharmacy (synthetic)'))
    const again = renderHook(() => usePharmacyNames(['rx1']))
    await waitFor(() => expect(again.result.current.rx1).toBe('Example Pharmacy (synthetic)'))
    expect(asked).toEqual(['rx1'])
  })

  it('shows no pharmacy line while it is being read', () => {
    answers.rx1 = () => new Promise(() => undefined)
    const { result } = renderHook(() => usePharmacyNames(['rx1']))
    expect(pharmacyText({ prescriptionId: 'rx1' }, result.current)).toBeUndefined()
  })

  it('never looks one up for a medicine with no prescription (a reported one)', () => {
    const { result } = renderHook(() => usePharmacyNames([]))
    expect(pharmacyText({}, result.current)).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('shows no pharmacy line for one refused lookup, and still names the others', async () => {
    answers.rx1 = forbidden
    answers.rx2 = atPharmacy('Example Pharmacy (synthetic)')
    const { result } = renderHook(() => usePharmacyNames(['rx1', 'rx2']))
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2))
    expect(pharmacyText({ prescriptionId: 'rx1' }, result.current)).toBeUndefined()
    expect(pharmacyText({ prescriptionId: 'rx2' }, result.current)).toBe('Pharmacy: Example Pharmacy (synthetic)')
  })

  it('shows no pharmacy line when the prescription names no pharmacy', async () => {
    answers.rx1 = () => Promise.resolve({ status: 200, data: { id: 'rx1' } })
    const { result } = renderHook(() => usePharmacyNames(['rx1']))
    await waitFor(() => expect(result.current.rx1).toBeNull())
    expect(pharmacyText({ prescriptionId: 'rx1' }, result.current)).toBeUndefined()
  })
})
