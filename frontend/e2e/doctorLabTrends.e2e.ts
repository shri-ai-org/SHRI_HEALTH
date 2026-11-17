import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// Item 3 of the demo plan: the Test results tab draws each test with two or more numeric values as a
// graph over time, with its range band, abnormal values marked in words, and a text summary; the
// report tables stay below. The doctors' portal as the development physician (md), on the seeded
// synthetic history patient Robert Miller (backend seed, #336). Skips when that seed isn't loaded.

const DOCTORS = `http://localhost:${doctorsPort}`

async function seeded(request: APIRequestContext, name: string): Promise<string | undefined> {
  const res = await request.post('/api/v1/patients/search', { data: { criteria: { query: name } } })
  expect(res.status(), await res.text()).toBe(200)
  const { items } = (await res.json()) as { items: { id: string }[] }
  return items[0]?.id
}

async function count(path: string): Promise<number> {
  const doctor = await apiRequest.newContext({ baseURL: DOCTORS })
  const res = await doctor.get(path)
  const n = res.status() === 200 ? ((await res.json()) as { items: unknown[] }).items.length : 0
  await doctor.dispose()
  return n
}

test('Test results graphs the HbA1c over time, high in words, with the tables below', async ({ page, request }) => {
  const id = await seeded(request, 'Robert Miller')
  test.skip(!id, 'The seeded history patient Robert Miller is not in this database (the backend seed of PR 336)')
  test.skip((await count(`/api/v1/patients/${id}/lab-results`)) < 2, 'Robert Miller has no repeated lab results')

  await page.goto(`${DOCTORS}/patient/${id}`)
  const tabs = page.getByRole('tablist', { name: /record/ })
  await expect(tabs.getByRole('tab', { name: /Test results/ })).toBeVisible({ timeout: 30_000 })
  await tabs.getByRole('tab', { name: /Test results/ }).click()

  const trends = page.getByRole('region', { name: 'Trends' })
  const a1c = trends.getByRole('region', { name: 'Hemoglobin A1c' })
  await expect(a1c).toBeVisible()
  await expect(a1c).toContainText('High (above 5.6)')
  await expect(a1c.getByRole('group', { name: /Hemoglobin A1c: Latest 7\.1 %, high; 3 results since/ })).toBeVisible()

  // Each value takes keyboard focus and says its date, value and flag.
  const points = a1c.getByRole('img', { name: /%/ })
  await expect(points).toHaveCount(3)
  await points.last().focus()
  await expect(points.last()).toBeFocused()
  await expect(points.last()).toHaveAccessibleName(/^[A-Z][a-z]{2} \d{1,2}, \d{4}: 7\.1 %, high$/)

  // The report tables are still there, below.
  await expect(page.getByRole('row', { name: /Hemoglobin A1c/ }).first()).toContainText('7.1')
})
