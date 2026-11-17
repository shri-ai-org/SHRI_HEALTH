import { expect, test } from '@playwright/test'

import { portalPort } from '../playwright.config'

// The patient portal's Test Results page on the real API (listPortalLabResults, #398): the signed-in
// patient's own lab results, newest first, held ones without content, and a graph for a test with
// two or more values. The portal runs as SHRI_E2E_PORTAL_PATIENT; without it, or while the API
// doesn't serve the read yet (Anand's portal-records backend), this test skips. Run it as a patient
// with results (Linda Thompson or Robert Miller in the demo seed) and as one with none (the demo
// portal patient): the page must match what the API answers for that patient.

const BASE = `http://localhost:${portalPort}`
const PORTAL = `${BASE}/portal`
const HELD = "This result isn't released yet. Your clinic will share it when it's ready."

interface Item {
  releaseStatus: 'available' | 'held'
  shortName?: string
  code?: { text?: string; display?: string }
  results?: { value?: { value: number; unit: string } }[]
}

test.skip(!process.env.SHRI_E2E_PORTAL_PATIENT, 'needs SHRI_E2E_PORTAL_PATIENT: a portal patient on the real API')

test("Test Results shows the patient's own results from the API, held ones without content", async ({ page }) => {
  const res = await page.request.get(`${BASE}/api/v1/portal/me/lab-results?limit=100`)
  test.skip(res.status() === 404, 'The API does not serve GET /portal/me/lab-results yet')
  expect(res.status(), await res.text()).toBe(200)
  const { items } = (await res.json()) as { items: Item[] }

  await page.goto(`${PORTAL}/`)
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Test Results', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Test Results', exact: true }).first()).toBeVisible()

  if (items.length === 0) {
    await expect(page.getByText('No test results on your record yet.')).toBeVisible()
  } else {
    const list = page.getByRole('list', { name: 'Your test results' })
    await expect(list.getByRole('listitem')).toHaveCount(items.length)
    const first = items[0]
    const row = list.getByRole('listitem').first()
    if (first.releaseStatus === 'held') await expect(row).toHaveText(HELD)
    else await expect(row).toContainText(first.shortName ?? first.code?.text ?? first.code?.display ?? '')
    // A held result never shows a value.
    for (const [i, it] of items.entries()) if (it.releaseStatus === 'held') await expect(list.getByRole('listitem').nth(i)).toHaveText(HELD)
  }
  // Nothing about the patient in the address (D13).
  expect(new URL(page.url()).pathname).toBe('/portal/test-results')
})
