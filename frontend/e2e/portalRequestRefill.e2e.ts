import { expect, test } from '@playwright/test'

import { portalPort } from '../playwright.config'

// "Request refill" on the patient portal's Prescriptions page (#415's API), as the development
// patient (SHRI_E2E_PORTAL_PATIENT) on the real API with VITE_FEATURE_REFILL_REQUESTS=on. It asks
// for a refill of the first medicine that offers one (a change in data: a local or test stack
// only), and skips without the real API, without the refill list, or when no medicine offers one.
// Synthetic patients only.

const PORTAL = `http://localhost:${portalPort}`

test.beforeEach(async ({ request }) => {
  const probe = await request.get(`${PORTAL}/api/v1/e2e-probe`).catch(() => null)
  test.skip(!probe || !(probe.headers()['content-type'] ?? '').includes('application/problem+json'), 'needs the real API and the portal dev server')
  const mine = await request.get(`${PORTAL}/api/v1/portal/me/refill-requests?limit=1`)
  test.skip(mine.status() !== 200, 'needs listPortalRefillRequests (PR 415) and a portal patient')
})

test('asks for a refill after the confirmation, and shows it as requested', async ({ page }) => {
  await page.goto(`${PORTAL}/portal/prescriptions`)
  await expect(page.getByRole('list', { name: 'Your medications' })).toBeVisible({ timeout: 15_000 })
  const button = page.getByRole('button', { name: /^Request a refill of / }).first()
  const offered = await button.waitFor({ timeout: 10_000 }).then(() => true, () => false)
  test.skip(!offered, 'no medicine offers a refill (each has an open request, or none is current)')
  const label = (await button.getAttribute('aria-label')) ?? ''
  const drug = label.replace(/^Request a refill of /, '')
  const item = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: drug, exact: true }) })

  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await button.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(`Ask your clinic to refill ${drug}.`, { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: 'Send request' }).click()

  await expect(item.getByText(/Your clinic will review it/)).toBeVisible()
  await expect(item.getByText('Refill requested', { exact: true })).toBeVisible()
  await expect(item.getByRole('button', { name: /^Request a refill of / })).toHaveCount(0)
  // The prescription travels in the request body; no drug name in any address.
  expect(urls.filter((u) => u.includes(encodeURIComponent(drug)) || u.includes(drug))).toEqual([])
})
