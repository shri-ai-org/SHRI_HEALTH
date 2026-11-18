import { randomInt } from 'node:crypto'
import { expect, test } from '@playwright/test'

import { frontOfficePort } from '../playwright.config'

// Demo step 1 on the front office: every demo name is Synthea-style, with digits (D112), so the
// register form must take them. Nothing is submitted here. Fictional names only.

const DESK = `http://localhost:${frontOfficePort}`

test('the register form takes Synthea-style names with digits', async ({ page }) => {
  await page.goto(`${DESK}/register/new`)
  await page.locator('#reg-firstName').fill('Kaia401')
  await page.locator('#reg-middleName').fill('Rae12')
  await page.locator('#reg-lastName').fill('Lindgren118')
  await page.locator('#reg-lastName').blur()
  await expect(page.getByText(/Invalid (first|middle|last) name|Invalid Username/)).toHaveCount(0)
  // A name must still start with a letter.
  await page.locator('#reg-firstName').fill('401Kaia')
  await page.locator('#reg-firstName').blur()
  await expect(page.getByText('Invalid first name')).toBeVisible()
})

// The consent checkbox (Financial Policy page): worded from the practice's required consent
// requirements (listConsentRequirements), Register blocked until it is ticked, and one consent per
// required requirement stored with the patient (registerPatient's consents). Real API only.
test('registration records the required consents once the box is ticked', async ({ page, request }) => {
  const probe = await request.get(`${DESK}/api/v1/consent-requirements?limit=100`)
  test.skip(probe.status() !== 200, 'needs the real API with listConsentRequirements')
  const required = ((await probe.json()) as { items: { kind: string; required: boolean; active: boolean }[] }).items.filter((r) => r.required && r.active)

  const n = String(randomInt(10, 99))
  await page.goto(`${DESK}/register/new`)
  await page.locator('#reg-firstName').fill('Avery')
  await page.locator('#reg-lastName').fill(`Consenttest${randomInt(1000, 9999)}`)
  await page.locator('#reg-date').fill('1988-04-12')
  await page.getByRole('button', { name: 'Female', exact: true }).click()
  await page.locator('#reg-phoneNo').fill(`(408) 555-01${n}`)
  await page.locator('#reg-address').fill('100 Sample Way')
  await page.locator('#reg-city').fill('San Jose')
  await page.locator('#reg-state').selectOption('CA')
  await page.locator('#reg-country').selectOption('US')
  await page.locator('#reg-zip').fill('95112')
  await page.locator('#reg-relationFirstname').fill('Jordan')
  await page.locator('#reg-relationLastname').fill('Sample')
  await page.locator('#reg-relationPhoneno').fill(`(408) 555-01${n === '99' ? '10' : String(Number(n) + 1)}`)
  await page.locator('#reg-relation').selectOption({ index: 1 })

  const consent = page.locator('#reg-consent')
  for (let step = 0; step < 9 && !(await consent.isVisible()); step += 1) await page.getByRole('button', { name: 'Next' }).click()
  await expect(consent).toBeVisible()
  await expect(page.getByText(/^The patient agrees to: /)).toBeVisible()

  // Register is blocked until the box is ticked.
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('The patient must agree to the consents before registering.')).toBeVisible()
  await consent.check()
  await page.getByRole('button', { name: 'Next' }).click()

  const created = page.waitForResponse((res) => res.request().method() === 'POST' && /\/api\/v1\/patients$/.test(new URL(res.url()).pathname))
  await page.getByRole('button', { name: 'Done' }).click()
  const res = await created
  expect(res.status()).toBe(201)
  const patientId = ((await res.json()) as { id: string }).id
  await expect(page.getByRole('dialog').getByText('Patient registered')).toBeVisible()

  const consents = await request.get(`${DESK}/api/v1/patients/${patientId}/consents`)
  expect(consents.status()).toBe(200)
  const stored = ((await consents.json()) as { items: { kind: string; decision: string; signatureMethod: string }[] }).items
  expect(stored.map((c) => c.kind).sort()).toEqual(required.map((r) => r.kind).sort())
  for (const c of stored) expect([c.decision, c.signatureMethod]).toEqual(['permit', 'electronic'])
})
