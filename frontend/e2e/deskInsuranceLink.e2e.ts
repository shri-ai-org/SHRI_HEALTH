import { randomInt, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

import { frontOfficePort } from '../playwright.config'

// M9 (RUN_CHECK 28): the patient's insurance (demo step 3) is reached from the patient profile,
// not only by typing a URL: the profile's Insurance button opens /patients/:id/insurance under the
// front office's own header, with the way back; the old /temporary/insurance address redirects,
// and no "TEMPORARY" label shows. The front office as the development front desk (fd), on a new
// synthetic patient. Synthetic data only.

const DESK = `http://localhost:${frontOfficePort}`

test('Insurance opens from the patient profile, and the old address redirects', async ({ page, request }) => {
  const res = await request.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: `Testins${randomInt(100000, 999999)}`, given: ['Rowan'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  })
  expect(res.status(), await res.text()).toBe(201)
  const { id } = (await res.json()) as { id: string }

  await page.goto(`${DESK}/patients/${id}`)
  await page.getByRole('button', { name: 'Insurance', exact: true }).click({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/patients/${id}/insurance$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Testins|Patient insurance/)
  await expect(page.getByRole('heading', { name: 'Insurance', level: 2 })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Add insurance' })).toBeVisible()
  await expect(page.locator('main')).not.toContainText('TEMPORARY')

  // The way back to the profile.
  await page.getByRole('link', { name: 'Patient profile' }).click()
  await expect(page).toHaveURL(new RegExp(`/patients/${id}$`))

  // The address the runbook used before still works.
  await page.goto(`${DESK}/temporary/insurance/${id}`)
  await expect(page).toHaveURL(new RegExp(`/patients/${id}/insurance$`))
})
