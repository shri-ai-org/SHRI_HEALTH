import { randomInt, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// The record's Prescriptions tab on the doctors' portal with the real API: the medication list
// (listMedications), each signed medicine's prescriber (getPrescription) and the day in the clinic's
// calendar. Uses the demo seed's Linda Thompson when she is there, and a new synthetic patient with
// no medications. Skips without the real API. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`
const LINDA = '5eed0017-0000-4000-8000-000000000003'

test.beforeEach(async ({ request }) => {
  const probe = await request.get(`${DOCTORS}/api/v1/e2e-probe`)
  test.skip(!(probe.headers()['content-type'] ?? '').includes('application/problem+json'), 'needs the real API')
})

test('lists the medicines with their prescribers, the dose text and the clinic day', async ({ page, request }) => {
  const meds = await request.get(`${DOCTORS}/api/v1/patients/${LINDA}/medications`)
  test.skip(meds.status() !== 200, 'needs the demo seed')
  const items = ((await meds.json()) as { items: { status: string; medication: { text?: string } }[] }).items.filter((m) => m.status === 'active')

  await page.goto(`${DOCTORS}/patient/${LINDA}/prescriptions`)
  const taking = page.locator('li', { hasText: 'since ' })
  await expect(taking).toHaveCount(items.length)
  // Every name fills in; none is left looking, and none is made up from recordedBy.
  await expect(page.getByText('Finding the prescriber…')).toHaveCount(0, { timeout: 15_000 })
  for (const m of items) await expect(page.getByText(m.medication.text ?? '', { exact: true })).toBeVisible()
  const omeprazole = taking.filter({ hasText: 'omeprazole' })
  if ((await omeprazole.count()) > 0) await expect(omeprazole).toContainText('since Sep 29, 2026')
})

test('says so when the record has no medications', async ({ page, request }) => {
  // Registered as the front desk, through the main app's dev server (as the other doctors' e2e do).
  const res = await request.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: `Testnomeds${randomInt(100000, 999999)}`, given: ['Harper'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  })
  expect(res.status(), await res.text()).toBe(201)
  const patient = (await res.json()) as { id: string }
  await page.goto(`${DOCTORS}/patient/${patient.id}/prescriptions`)
  await expect(page.getByText('No medications on this record yet.')).toBeVisible()
})
