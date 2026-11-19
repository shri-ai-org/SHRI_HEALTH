import { randomInt, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// The record's Prescriptions tab on the doctors' portal with the real API: the medication list
// (listMedications) with each signed medicine's prescriber, its pharmacy (getPrescription, once per
// prescription) and the day in the clinic's calendar. Uses the demo seed's Linda Thompson when she is there, and a new synthetic patient with
// no medications. Skips without the real API. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`
const LINDA = '5eed0017-0000-4000-8000-000000000003'

test.beforeEach(async ({ request }) => {
  const probe = await request.get(`${DOCTORS}/api/v1/e2e-probe`)
  test.skip(!(probe.headers()['content-type'] ?? '').includes('application/problem+json'), 'needs the real API')
})

type Listed = { status: string; source: string; prescriptionId?: string; prescriberDisplayName?: string; medication: { text?: string } }

test('lists the medicines with their prescribers and pharmacies, the dose text and the clinic day', async ({ page, request }) => {
  const meds = await request.get(`${DOCTORS}/api/v1/patients/${LINDA}/medications`)
  test.skip(meds.status() !== 200, 'needs the demo seed')
  const items = ((await meds.json()) as { items: Listed[] }).items.filter((m) => m.status === 'active')
  const asked: string[] = []
  page.on('request', (r) => {
    const m = /\/api\/v1\/prescriptions\/([0-9a-f-]{36})$/.exec(new URL(r.url()).pathname)
    if (m && r.method() === 'GET') asked.push(m[1])
  })

  await page.goto(`${DOCTORS}/patient/${LINDA}/prescriptions`)
  const taking = page.locator('li', { hasText: 'since ' })
  await expect(taking).toHaveCount(items.length)
  for (const m of items) {
    const row = taking.filter({ has: page.getByText(m.medication.text ?? '', { exact: true }) })
    // The prescriber is the list's own name, never recordedBy; a reported medicine says so.
    const by = m.source === 'prescription' ? (m.prescriberDisplayName ?? 'Prescriber unavailable') : 'Reported'
    await expect(row.first()).toContainText(by)
    if (!m.prescriptionId) continue
    const rx = await request.get(`${DOCTORS}/api/v1/prescriptions/${m.prescriptionId}`)
    const pharmacy = rx.status() === 200 ? ((await rx.json()) as { pharmacyName?: string }).pharmacyName : undefined
    if (pharmacy) await expect(row.first()).toContainText(`Pharmacy: ${pharmacy}`)
  }
  // Each prescription is read once for its pharmacy, and only those.
  const ids = [...new Set(items.map((m) => m.prescriptionId).filter(Boolean))]
  expect([...new Set(asked)].sort()).toEqual(ids.sort())
  expect(asked.length).toBe(new Set(asked).size)
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
