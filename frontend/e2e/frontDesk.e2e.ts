import { expect, test } from '@playwright/test'

// The front desk against the real API. Synthetic data only. Patient search and registration
// join this file when the patients API (#78) is on main; booking, reschedule and check-in when the
// scheduling API (PR-3 to PR-5) is.

test('the dev server reaches the real API, not the mock', async ({ request }) => {
  // An unknown path under /api/v1: only our API answers it with a Problem and an X-Request-ID
  // (API_STANDARDS §9, §18). Prism or a proxy error would not.
  const res = await request.get('/api/v1/e2e-probe')
  expect(res.status()).toBe(404)
  expect(res.headers()['content-type']).toContain('application/problem+json')
  expect(res.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
})

test('the front desk opens signed in as the development user', async ({ page }) => {
  await page.goto('/patients/search')
  await expect(page.getByRole('heading', { name: 'Find a patient' })).toBeVisible()
  await expect(page.getByText('Dev FD · Dev Clinic A')).toBeVisible()
})
