import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort, frontOfficePort } from '../playwright.config'

// D117: the search boxes list patients from the first letter typed, by the start of any name or of
// the MRN, in the front office and the doctors' portal. Setup through the API as the front desk: a
// synthetic patient with an unusual last name. Synthetic data only.

const DESK = `http://localhost:${frontOfficePort}`
const DOCTORS = `http://localhost:${doctorsPort}`

async function patient(desk: APIRequestContext): Promise<{ family: string; given: string; mrn: string }> {
  const family = `Qtyped${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`
  const given = 'Rowena'
  const res = await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family, given: [given] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  })
  expect(res.status(), await res.text()).toBe(201)
  return { family, given, mrn: ((await res.json()) as { mrn: string }).mrn }
}

test('front office: one typed letter lists patients; more letters narrow to the one', async ({ page, request }) => {
  const p = await patient(request)
  await page.goto(`${DESK}/patients`)
  const box = page.getByRole('combobox', { name: 'Search patients' }).or(page.getByPlaceholder('name, phone, MRN or date of birth')).first()
  await box.fill('q')
  await expect(page.getByRole('listbox', { name: 'Patients' }).getByRole('option').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('No patient found')).toHaveCount(0)
  await box.fill(p.family.slice(0, 9).toLowerCase())
  await expect(page.getByRole('option', { name: new RegExp(p.family) })).toBeVisible({ timeout: 15_000 })
  await box.fill(`${p.given.slice(0, 2)} ${p.family.slice(0, 9)}`)
  await expect(page.getByRole('option', { name: new RegExp(p.family) })).toBeVisible({ timeout: 15_000 })
})

test("doctors' portal: the search finds a patient from part of the name or the MRN", async ({ page, request }) => {
  const p = await patient(request)
  await page.goto(`${DOCTORS}/`)
  await page.keyboard.press('/')
  const box = page.getByRole('combobox', { name: 'Patient search' })
  if (!(await box.isVisible())) await page.getByRole('button', { name: /search/i }).first().click()
  await box.fill('q')
  await expect(page.getByRole('listbox', { name: 'Results' }).getByRole('option').first()).toBeVisible({ timeout: 15_000 })
  await box.fill(p.family.slice(0, 9))
  await expect(page.getByRole('option', { name: new RegExp(p.family) })).toBeVisible({ timeout: 15_000 })
  await box.fill(p.mrn)
  await expect(page.getByRole('option', { name: new RegExp(p.family) })).toBeVisible({ timeout: 15_000 })
})
