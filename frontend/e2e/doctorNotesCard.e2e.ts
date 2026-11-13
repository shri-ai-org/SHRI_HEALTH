import { expect, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// M7 (RUN_CHECK 7): with the API, the record overview's "Consultation notes" card lists the
// server's signed notes, as the Notes tab does, and has no mic or + (they made notes that stayed in
// the browser and were never saved); the Notes tab has no dictation button either. The doctors'
// portal as the development physician (md), on a seeded history patient with signed notes
// (backend seed); skips when that seed isn't loaded. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`

async function seeded(request: APIRequestContext, name: string): Promise<string | undefined> {
  const res = await request.post('/api/v1/patients/search', { data: { criteria: { query: name } } })
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()) as { items: { id: string }[] }).items[0]?.id
}

test("the overview's notes card lists the server's signed notes, with no browser-only dictation", async ({ page, request }) => {
  const id = await seeded(request, 'Robert Miller')
  test.skip(!id, 'The seeded history patient Robert Miller is not in this database')

  // The Notes tab: its signed notes, and no "Add note" mic.
  await page.goto(`${DOCTORS}/patient/${id}/notes`)
  await expect(page.getByText('Consultation').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Add note' })).toHaveCount(0)

  // The overview's card: the same notes, newest first, and no mic or +.
  await page.goto(`${DOCTORS}/patient/${id}`)
  const card = page.getByLabel(/^Consultation notes on /)
  const list = card.getByRole('list', { name: 'Signed notes, newest first' })
  await expect(list).toBeVisible({ timeout: 30_000 })
  const rows = await list.getByRole('listitem').count()
  expect(rows).toBeGreaterThan(0)
  expect(rows).toBeLessThanOrEqual(5)
  await expect(card).not.toContainText('No notes yet')
  // Dates U.S. style in the clinic's calendar ("Sep 15, 2026"), never the sample's "15-Sep-2026".
  await expect(list.getByRole('listitem').first()).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{4}/)
  await expect(card).not.toContainText(/\d{2}-[A-Z][a-z]{2}-\d{4}/)
  await expect(card.getByRole('button', { name: /^Dictate a note on / })).toHaveCount(0)
  await expect(card.getByRole('button', { name: /^Type a note on / })).toHaveCount(0)
  // Each row opens the Notes tab.
  await list.getByRole('link').first().click()
  await expect(page).toHaveURL(new RegExp(`/patient/${id}/notes$`))
})
