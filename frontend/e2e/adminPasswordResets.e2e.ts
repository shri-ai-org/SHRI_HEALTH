import { expect, test } from '@playwright/test'

import { frontOfficeAdminPort } from '../playwright.config'

// Administration > Password resets (#85), as the development administrator (adm) on the real API.
// Until the contract and core's password-resets:approve exist, the section shows only on the
// development preview (VITE_PASSWORD_HELP_PREVIEW=on), with its synthetic requests: Jordan Example
// (approved), Casey Sample (declined with a note) and Riley Test (already decided: a 409). Skips
// without the real API or when the section is off. Fictional people only.

const ADMIN = `http://localhost:${frontOfficeAdminPort}`

test.beforeEach(async ({ request }) => {
  const probe = await request.get(`${ADMIN}/api/v1/e2e-probe`).catch(() => null)
  test.skip(!probe || !(probe.headers()['content-type'] ?? '').includes('application/problem+json'), 'needs the real API')
})

test('approves after confirming, declines with a note, and handles an already-decided request', async ({ page }) => {
  await page.goto(`${ADMIN}/admin/password-resets`)
  const tab = page.getByRole('link', { name: 'Password resets' })
  const on = await tab.waitFor({ timeout: 15_000 }).then(() => true, () => false)
  test.skip(!on, 'the section is off (VITE_FEATURE_PASSWORD_HELP, and password-resets:approve or the development preview)')
  await expect(page.getByRole('heading', { name: 'Password resets' })).toBeVisible()
  await expect(page.getByRole('table').getByText('Jordan Example')).toBeVisible()

  // Approve asks first; nothing happens until it is confirmed.
  await page.getByRole('button', { name: 'Approve the reset for Jordan Example' }).click()
  const confirm = page.getByRole('dialog')
  await expect(confirm.getByText('Approve this password reset?')).toBeVisible()
  await confirm.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(/Approved\. Jordan Example will get an email/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve the reset for Jordan Example' })).toHaveCount(0)

  // Decline with an optional note.
  await page.getByRole('button', { name: 'Decline the reset for Casey Sample' }).click()
  await page.getByLabel(/Note for the requester/).fill('Please call the front desk.')
  await page.getByRole('dialog').getByRole('button', { name: 'Decline' }).click()
  await expect(page.getByText(/Declined\. Casey Sample will see/)).toBeVisible()

  // A request already decided elsewhere: the screen says so and reads the list again.
  await page.getByRole('button', { name: 'Approve the reset for Riley Test' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('That request was already decided or has expired. The list has been updated.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve the reset for Riley Test' })).toHaveCount(0)

  // Nothing about the requests in the address.
  expect(page.url()).toBe(`${ADMIN}/admin/password-resets`)
})
