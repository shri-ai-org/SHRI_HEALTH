import { expect, test } from '@playwright/test'

import { portalPort } from '../playwright.config'

// "Forgot password?" for patients (#85): /portal/password-help and its status page. Real API only
// (skips without it, and without the portal's dev server, which runs only when
// SHRI_E2E_PORTAL_PATIENT is set), and only when the build turns the pages on
// (VITE_FEATURE_PASSWORD_HELP=on). Until the contract is on main the request answers "unavailable";
// once it is wired, the same walk sees "Request sent" for any input. Synthetic values only.

const PORTAL = `http://localhost:${portalPort}/portal`
const IDENTIFIER = '4085550199'

test.beforeEach(async ({ request }) => {
  const probe = await request.get(`http://localhost:${portalPort}/api/v1/e2e-probe`).catch(() => null)
  test.skip(!probe || !(probe.headers()['content-type'] ?? '').includes('application/problem+json'), 'needs the real API and the portal dev server')
})

test('the request form opens without signing in, and the mobile number never reaches a URL', async ({ page }) => {
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await page.goto(`${PORTAL}/password-help`)
  const field = page.getByLabel(/Username or mobile number/)
  const on = await field.waitFor({ timeout: 10_000 }).then(() => true, () => false)
  test.skip(!on, 'the pages are off in this build (VITE_FEATURE_PASSWORD_HELP)')
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await field.fill(IDENTIFIER)
  await page.getByRole('button', { name: 'Send request' }).click()
  await expect(page.getByText(/Request sent|isn't available right now/)).toBeVisible()
  await expect(page.getByText(/not found|no account|does not exist/i)).toHaveCount(0)
  expect(urls.filter((u) => u.includes(IDENTIFIER))).toEqual([])
  expect(page.url()).not.toContain(IDENTIFIER)
})

test('the status page takes its token from the fragment and removes it from the address', async ({ page }) => {
  const token = 'portal-status-token-for-the-e2e'
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await page.goto(`${PORTAL}/password-help/status#status=${token}`)
  const heading = page.getByRole('heading', { name: 'Your password reset request' })
  const on = await heading.waitFor({ timeout: 10_000 }).then(() => true, () => false)
  test.skip(!on, 'the pages are off in this build (VITE_FEATURE_PASSWORD_HELP)')
  expect(page.url()).not.toContain(token)
  expect(urls.filter((u) => u.includes(token))).toEqual([])
  await expect(page.locator('main input')).toHaveCount(0)
})
