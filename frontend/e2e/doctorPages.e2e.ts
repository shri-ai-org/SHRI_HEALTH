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
  // The signed-in doctor's name as the API gives it (the seed names the demo doctor, D112), and
  // the greeting's rule: "Dr." and the surname alone for a "Dr." name, else the whole name.
  const me = (await (await page.request.get(`${DOCTORS}/api/v1/me`)).json()) as { user: { displayName: string } }
  const name = me.user.displayName
  const short = /^Dr\.?\s/.test(name) ? `Dr. ${name.split(' ').slice(-1)[0]}` : name
  const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The first visit compiles the home on a cold dev server; reading the day takes a few calls.
  await expect(page.getByText(new RegExp(`Good (morning|afternoon|evening), ${escaped}`)).first()).toBeVisible({ timeout: 30_000 })
  // Today in the clinic's own zone, read from the API (D40), never a fixed zone.
  const facilities = (await (await page.request.get(`${DOCTORS}/api/v1/booking/facilities`)).json()) as { items: { timeZone: string }[] }
  const timeZone = facilities.items[0].timeZone
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone }).format(new Date())
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

test('every tab on the patient record opens a screen with the API', async ({ page, request }) => {
  // A synthetic patient, registered by the front desk through the API.
  const res = await request.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { name: { family: `Tabcheck${Date.now().toString(36)}`, given: ['Rowan'] }, birthDate: '1970-04-12' },
  })
  expect(res.status(), await res.text()).toBe(201)
  const { id } = (await res.json()) as { id: string }
  await page.goto(`${DOCTORS}/patient/${id}`)
  const tabs = page.getByRole('tablist', { name: /record/ }).getByRole('tab')
  await expect(tabs.first()).toBeVisible({ timeout: 30_000 })
  const names = await tabs.allInnerTexts()
  // Every part of the record has a tab with the API, Test results and Imaging reports included.
  for (const tab of ['Overview', 'Condition', 'History', 'Test results', 'Imaging reports', 'Consultation notes', 'Prescriptions', 'Appointments']) {
    expect(names.join(' ')).toContain(tab)
  }
  for (let i = 0; i < names.length; i += 1) {
    await page.getByRole('tablist', { name: /record/ }).getByRole('tab').nth(i).click()
    await expect(page.getByRole('tablist', { name: /record/ })).toBeVisible()
    await expect(page.getByText('No screen at this address')).toHaveCount(0)
  }
})
