import { expect, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// Item 4 of the demo plan: the record overview's "At a glance" card, six rows from the reads the
// record already uses. The doctors' portal as the development physician (md), on the seeded
// synthetic history patients Robert Miller (every row filled) and Linda Thompson (no abnormal lab
// results). Skips when that seed (#329, #336) isn't loaded. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`
const ROWS = ['Active problems', 'Current medications', 'Allergies', 'Latest vitals', 'Latest abnormal results', 'Last visit']

async function seeded(request: APIRequestContext, name: string): Promise<string | undefined> {
  const res = await request.post('/api/v1/patients/search', { data: { criteria: { query: name } } })
  expect(res.status(), await res.text()).toBe(200)
  const { items } = (await res.json()) as { items: { id: string }[] }
  return items[0]?.id
}

test('At a glance shows six rows for Robert Miller, and a row title opens its tab', async ({ page, request }) => {
  const id = await seeded(request, 'Robert Miller')
  test.skip(!id, 'The seeded history patient Robert Miller is not in this database (the backend seed of PR 329)')

  await page.goto(`${DOCTORS}/patient/${id}`)
  const card = page.getByRole('region', { name: 'At a glance' })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveAttribute('aria-busy', 'false')
  for (const row of ROWS) await expect(card.getByRole('term').filter({ hasText: row })).toBeVisible()
  await expect(card).not.toContainText("Couldn't load")
  await expect(card).toContainText('amoxicillin')
  await expect(card).toContainText('Hemoglobin A1c')
  await expect(card).toContainText('High')

  await card.getByRole('link', { name: 'Active problems' }).click()
  await expect(page).toHaveURL(new RegExp(`/patient/${id}/condition$`))
})

test('An empty row says so: Linda Thompson has no abnormal lab results', async ({ page, request }) => {
  const id = await seeded(request, 'Linda Thompson')
  test.skip(!id, 'The seeded history patient Linda Thompson is not in this database (the backend seed of PR 329)')

  await page.goto(`${DOCTORS}/patient/${id}`)
  const card = page.getByRole('region', { name: 'At a glance' })
  await expect(card).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 })
  const labs = card.getByRole('definition').nth(ROWS.indexOf('Latest abnormal results'))
  await expect(labs).toHaveText('None recorded')
})
