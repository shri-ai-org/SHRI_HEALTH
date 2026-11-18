import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../src/api/client'
import { prescriberText } from '../src/shri/logic/medicationDisplay'
import { forgetPrescribers, usePrescriberNames } from './prescribers'

// The record's Prescriptions page: each signed medicine's prescriber from its prescription
// (getPrescription). A plain stand-in, not a vi.fn, so a refused lookup can reject. Synthetic only.
const answers: Record<string, () => Promise<unknown>> = {}
const asked: string[] = []
vi.mock('../../src/api/generated/endpoints/medications/medications', () => ({
  getPrescription: (id: string) => {
    asked.push(id)
    return answers[id]()
  },
}))

const named = (name: string) => () => Promise.resolve({ status: 200, data: { id: 'rx', prescriberDisplayName: name } })
const forbidden = () => Promise.reject(new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden' } as never, new Headers()))

beforeEach(() => {
  forgetPrescribers()
  asked.length = 0
})

describe('the prescriber of each medicine', () => {
  it('names the prescriber of each prescribed medicine, reading each prescription once, together', async () => {
    answers.rx1 = named('Dr. Example Prescriber MD')
    answers.rx2 = named('Example Nurse Practitioner, NP')
    const { result } = renderHook(() => usePrescriberNames(['rx1', 'rx2', 'rx1']))
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2))
    expect(prescriberText({ prescriptionId: 'rx1', by: 'Prescribed here' }, result.current)).toBe('Dr. Example Prescriber MD')
    expect(prescriberText({ prescriptionId: 'rx2', by: 'Prescribed here' }, result.current)).toBe('Example Nurse Practitioner, NP')
    expect(asked.sort()).toEqual(['rx1', 'rx2'])
  })

  it('shows nothing yet while a name is being read (the page shows its placeholder)', () => {
    answers.rx1 = () => new Promise(() => undefined)
    const { result } = renderHook(() => usePrescriberNames(['rx1']))
    expect(prescriberText({ prescriptionId: 'rx1', by: 'Prescribed here' }, result.current)).toBeUndefined()
  })

  it('keeps the list’s own words for a medicine with no prescription, and never looks one up', () => {
    const { result } = renderHook(() => usePrescriberNames([]))
    expect(prescriberText({ by: 'Prescribed here' }, result.current)).toBe('Prescribed here')
    expect(prescriberText({ by: 'Reported' }, result.current)).toBe('Reported')
    expect(asked).toEqual([])
  })

  it('says "Prescriber unavailable" for one refused lookup, and still names the others', async () => {
    answers.rx1 = forbidden
    answers.rx2 = named('Dr. Example Prescriber MD')
    const { result } = renderHook(() => usePrescriberNames(['rx1', 'rx2']))
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2))
    expect(prescriberText({ prescriptionId: 'rx1', by: 'Prescribed here' }, result.current)).toBe('Prescriber unavailable')
    expect(prescriberText({ prescriptionId: 'rx2', by: 'Prescribed here' }, result.current)).toBe('Dr. Example Prescriber MD')
  })

  it('says "Prescriber unavailable" when the prescription has no prescriber name', async () => {
    answers.rx1 = () => Promise.resolve({ status: 200, data: { id: 'rx1' } })
    const { result } = renderHook(() => usePrescriberNames(['rx1']))
    await waitFor(() => expect(result.current.rx1).toBeNull())
    expect(prescriberText({ prescriptionId: 'rx1', by: 'Prescribed here' }, result.current)).toBe('Prescriber unavailable')
  })
})
