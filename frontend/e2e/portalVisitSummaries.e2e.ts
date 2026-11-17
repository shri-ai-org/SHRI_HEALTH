import { expect, test } from '@playwright/test'

import { portalPort } from '../playwright.config'

// The patient portal's previous visits and their visit summaries on the real API (#395): My
// Appointments lists past visits, a visit with a summary is marked and opens it, and the summary
// page offers its download. The portal runs as SHRI_E2E_PORTAL_PATIENT; without it, or while the API
// doesn't serve the summaries, this test skips. Run it as a patient with past visits (Linda Thompson
// in the demo seed). Until the download link is served (#280), Open shows "can't be downloaded yet".

const BASE = `http://localhost:${portalPort}`
const PORTAL = `${BASE}/portal`

test.skip(!process.env.SHRI_E2E_PORTAL_PATIENT, 'needs SHRI_E2E_PORTAL_PATIENT: a portal patient on the real API')

test('a past visit opens its visit summary, which offers the download', async ({ page, context }) => {
  const res = await page.request.get(`${BASE}/api/v1/portal/me/visit-summaries?limit=100`)
  test.skip(res.status() === 404, 'The API does not serve the portal visit summaries yet')
  expect(res.status(), await res.text()).toBe(200)
  const { items } = (await res.json()) as { items: { id: string; releaseStatus: 'available' | 'held' }[] }
  test.skip(items.length === 0, 'This patient has no visit summaries')
  const first = items[0]!

  await page.goto(`${PORTAL}/appointments`)
  const tile = page.locator(`a[href="/portal/visit-summaries/${first.id}"]`)
  await expect(tile).toContainText('Visit summary')
  await tile.click()
  await expect(page.getByRole('heading', { name: 'Visit Summary' })).toBeVisible()
  // Nothing about the patient in the address (D13): the summary's opaque ID only.
  expect(new URL(page.url()).pathname).toBe(`/portal/visit-summaries/${first.id}`)

  if (first.releaseStatus === 'held') {
    await expect(page.getByText(/Held by your clinician/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open visit summary' })).toHaveCount(0)
    return
  }
  const link = await page.request.get(`${BASE}/api/v1/portal/me/visit-summaries/${first.id}/download-url`)
  if (link.status() === 404) {
    await page.getByRole('button', { name: 'Open visit summary' }).click()
    await expect(page.getByText("This summary can't be downloaded yet")).toBeVisible()
  } else {
    const opened = context.waitForEvent('page')
    await page.getByRole('button', { name: 'Open visit summary' }).click()
    await opened
  }
})
