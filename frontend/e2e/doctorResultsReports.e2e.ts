import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// The patient record's Test results and Imaging reports tabs with the API (listLabResults,
// listImagingReports): the doctors' portal as the development physician (md), on the seeded
// synthetic history patients (backend seed, #336). Skips when that seed isn't loaded. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`

/** The seeded patient's ID, found by the front desk's patient search (D13: criteria in the body). */
async function seeded(request: APIRequestContext, name: string): Promise<string | undefined> {
  const res = await request.post('/api/v1/patients/search', { data: { criteria: { query: name } } })
  expect(res.status(), await res.text()).toBe(200)
  const { items } = (await res.json()) as { items: { id: string }[] }
  return items[0]?.id
}

/** The doctor's read of one list, to skip when the seed has no rows for it. */
async function count(path: string): Promise<number> {
  const doctor = await apiRequest.newContext({ baseURL: DOCTORS })
  const res = await doctor.get(path)
  const n = res.status() === 200 ? ((await res.json()) as { items: unknown[] }).items.length : 0
  await doctor.dispose()
  return n
}

test('Test results shows the HbA1c with its value, unit and High flag', async ({ page, request }) => {
  const id = await seeded(request, 'Robert Miller')
  test.skip(!id, 'The seeded history patient Robert Miller is not in this database (the backend seed of PR 336)')
  test.skip((await count(`/api/v1/patients/${id}/lab-results`)) === 0, 'Robert Miller has no seeded lab results')

  await page.goto(`${DOCTORS}/patient/${id}`)
  const tabs = page.getByRole('tablist', { name: /record/ })
  await expect(tabs.getByRole('tab', { name: /Test results/ })).toBeVisible({ timeout: 30_000 })
  await tabs.getByRole('tab', { name: /Test results/ }).click()

  const row = page.getByRole('row', { name: /Hemoglobin A1c|HbA1c/ }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('7.1')
  await expect(row).toContainText('%')
  await expect(row).toContainText('High')
  await expect(page.getByText('No screen at this address')).toHaveCount(0)
})

test('Imaging reports shows the lumbar MR impression as text, with no images', async ({ page, request }) => {
  const id = await seeded(request, 'Linda Thompson')
  test.skip(!id, 'The seeded history patient Linda Thompson is not in this database (the backend seed of PR 336)')
  test.skip((await count(`/api/v1/patients/${id}/imaging-reports`)) === 0, 'Linda Thompson has no seeded imaging reports')

  await page.goto(`${DOCTORS}/patient/${id}/reports`)
  const main = page.locator('main')
  await expect(main.getByText(/MR lumbar spine/i).first()).toBeVisible({ timeout: 30_000 })
  await expect(main.getByText(/Degenerative disc disease at L4-L5 and L5-S1/).first()).toBeVisible()
  await expect(main.getByText('Full report')).toBeVisible()
  await expect(main.locator('img, canvas')).toHaveCount(0)
  await expect(main).not.toContainText('Open images')
  await expect(main).not.toContainText(/No imaging on file|no images with this report/)

  // The Overview's imaging card: the latest report's impression, as text.
  await page.goto(`${DOCTORS}/patient/${id}`)
  await expect(main.getByText(/Degenerative disc disease at L4-L5 and L5-S1/).first()).toBeVisible({ timeout: 30_000 })
  await expect(main).not.toContainText(/No imaging on file|Open in Imaging/)
})
