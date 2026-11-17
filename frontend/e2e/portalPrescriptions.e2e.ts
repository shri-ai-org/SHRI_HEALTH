import { expect, test } from '@playwright/test'

import { portalPort } from '../playwright.config'

// The patient portal's Prescriptions page on the real API (listPortalMedications, #389): the signed-in
// patient's own medications, read only, with no refill step. The portal runs as
// SHRI_E2E_PORTAL_PATIENT; without it this test skips. Run it as a patient with medications (Linda
// Thompson in the demo seed) and as one with none (the demo portal patient): the page must match
// what the API answers for that patient, a list or "No medications on your record yet.".

const BASE = `http://localhost:${portalPort}`
const PORTAL = `${BASE}/portal`

test.skip(!process.env.SHRI_E2E_PORTAL_PATIENT, 'needs SHRI_E2E_PORTAL_PATIENT: a portal patient on the real API')

test("Prescriptions shows the patient's own medications from the API, with no refill step", async ({ page }) => {
  const res = await page.request.get(`${BASE}/api/v1/portal/me/medications?limit=100`)
  expect(res.status(), await res.text()).toBe(200)
  const { items } = (await res.json()) as { items: { display: string; dosageText?: string }[] }

  await page.goto(`${PORTAL}/`)
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Prescriptions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Prescriptions' })).toBeVisible()
  await expect(page.getByText('To request a refill, contact your clinic.')).toBeVisible()

  if (items.length === 0) {
    await expect(page.getByText('No medications on your record yet.')).toBeVisible()
  } else {
    const list = page.getByRole('list', { name: 'Your medications' })
    await expect(list.getByRole('listitem')).toHaveCount(items.length)
    await expect(list.getByRole('listitem').first()).toContainText(items[0].display)
    if (items[0].dosageText) await expect(list.getByRole('listitem').first()).toContainText(items[0].dosageText)
  }
  await expect(page.getByRole('button', { name: /refill/i })).toHaveCount(0)
  // Nothing about the patient in the address (D13).
  expect(new URL(page.url()).pathname).toBe('/portal/prescriptions')
})
