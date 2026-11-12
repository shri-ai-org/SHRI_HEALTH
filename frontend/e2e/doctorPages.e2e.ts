import { expect, test } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// The doctors' portal with the API (its dev server runs SHRI_API=real, as production builds now do
// by default): the home shows the signed-in doctor's real day, and screens with no service yet
// answer "not found" instead of the mock-up's sample data. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`
/** Strings that only the mock-up's sample data contains. */
const SAMPLE = /Indostates|Coimbatore|Rajsrinivas|21-Sep-2026/

test('the home shows the signed-in doctor, today and the clinic, not sample data', async ({ page }) => {
  await page.goto(`${DOCTORS}/`)
  // The first visit compiles the home on a cold dev server; reading the day takes a few calls.
  await expect(page.getByText(/Good (morning|afternoon|evening), Dev MD/).first()).toBeVisible({ timeout: 30_000 })
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }).format(new Date())
  await expect(page.getByText(today).first()).toBeVisible()
  await expect(page.locator('main')).not.toContainText(SAMPLE)
})

for (const path of ['/ip/patients', '/results/inbox', '/discharge/board', '/radiology/worklist', '/tele/queue',
  '/stroke/wall', '/referrals', '/clinician/cosign', '/schedule/templates', '/schedule/blocks', '/patients/cohorts',
  '/orders/sets', '/pharmacy/adr', '/demo/patient']) {
  test(`${path} has no screen with the API`, async ({ page }) => {
    await page.goto(`${DOCTORS}${path}`)
    await expect(page.getByText('No screen at this address')).toBeVisible()
    await expect(page.locator('body')).not.toContainText(SAMPLE)
  })
}
