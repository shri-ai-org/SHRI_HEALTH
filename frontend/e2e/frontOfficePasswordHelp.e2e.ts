import { expect, test } from '@playwright/test'

import { frontOfficePort } from '../playwright.config'

// "Forgot password?" for staff (#85): the public request form at /password-help and the status
// page. Real API only (skips without it), and only when the build turns the pages on
// (VITE_FEATURE_PASSWORD_HELP=on). Until the contract is on main the request answers "unavailable";
// once it is wired, the same walk sees "Request sent" for any username. Synthetic usernames only.

const DESK = `http://localhost:${frontOfficePort}`
const USERNAME = 'example.nobody.e2e'

test.beforeEach(async ({ request }) => {
  const probe = await request.get(`${DESK}/api/v1/e2e-probe`)
  test.skip(!(probe.headers()['content-type'] ?? '').includes('application/problem+json'), 'needs the real API')
})

test('the request form opens without a session, and the username never reaches a URL', async ({ page }) => {
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await page.goto(`${DESK}/password-help`)
  const field = page.getByLabel(/Username/)
  const on = await field.waitFor({ timeout: 10_000 }).then(() => true, () => false)
  test.skip(!on, 'the pages are off in this build (VITE_FEATURE_PASSWORD_HELP)')
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await field.fill(USERNAME)
  await page.getByRole('button', { name: 'Send request' }).click()
  // The answer is announced; until the contract is wired it is "unavailable", and after that the one
  // answer for every account. Never "not found".
  await expect(page.getByText(/Request sent|isn't available right now/)).toBeVisible()
  await expect(page.getByText(/not found|no account|does not exist/i)).toHaveCount(0)
  expect(urls.filter((u) => u.includes(USERNAME))).toEqual([])
  expect(page.url()).not.toContain(USERNAME)
})

test('the status page takes its token from the fragment and removes it from the address', async ({ page }) => {
  const token = 'status-token-for-the-e2e-test'
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await page.goto(`${DESK}/password-help/status#status=${token}`)
  const heading = page.getByRole('heading', { name: 'Your password reset request' })
  const on = await heading.waitFor({ timeout: 10_000 }).then(() => true, () => false)
  test.skip(!on, 'the pages are off in this build (VITE_FEATURE_PASSWORD_HELP)')
  await expect(page.getByRole('status')).toBeVisible()
  expect(page.url()).not.toContain(token)
  expect(urls.filter((u) => u.includes(token))).toEqual([])
  await expect(page.locator('input')).toHaveCount(0)
})
