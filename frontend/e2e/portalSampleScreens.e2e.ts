import { expect, test } from '@playwright/test'

import { portalPort } from '../playwright.config'

// M4: on the real API the patient portal shows no screen that still runs on sample data (test
// results, messages, prescriptions, documents, reports, document templates, e-signature): not in
// the menus, not on the home page, and their URLs answer "Page not found". The portal runs as
// SHRI_E2E_PORTAL_PATIENT (SHRI_API=real); without it this test skips. Synthetic data only.

const PORTAL = `http://localhost:${portalPort}/portal`
const HIDDEN = [
  ['/test-results', 'Test Results'],
  ['/messages/inbox', 'Messages'],
  ['/messages/compose', 'Compose'],
  ['/prescriptions', 'Prescriptions'],
  ['/patient-documents', 'Patient Documents'],
  ['/reports', 'Reports'],
  ['/document-templates', 'Document Template'],
  ['/e-signature', 'E-Signature'],
  ['/billing', 'Billing'],
  ['/video-consult', 'Video Consult'],
  ['/immunizations', 'Immunization'],
  ['/demographics', 'Demographics'],
] as const

test.skip(!process.env.SHRI_E2E_PORTAL_PATIENT, 'needs SHRI_E2E_PORTAL_PATIENT: a portal patient on the real API')

test('no sample-data screen is reachable in the portal', async ({ page }) => {
  await page.goto(`${PORTAL}/`)
  await expect(page.getByRole('link', { name: /Appointments/ }).first()).toBeVisible()
  // The main menu keeps Appointments (it used to drop it with Test Results hidden).
  await expect(page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Appointments', exact: true })).toBeVisible()
  const main = page.getByRole('navigation', { name: 'Main' }).first()
  const body = page.locator('body')
  for (const [, label] of HIDDEN) {
    await expect(main.getByRole('link', { name: label, exact: true })).toHaveCount(0)
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(`^${label}\\b`) })).toHaveCount(0)
  }
  // The Health Summary and name menus list only real-API screens.
  await page.getByRole('button', { name: /Health Summary/ }).click()
  for (const label of ['Patient Documents', 'Reports', 'Document Template', 'Immunization']) {
    await expect(page.locator('#health-menu').getByRole('link', { name: label, exact: true })).toHaveCount(0)
  }
  await expect(page.locator('#health-menu').getByRole('link', { name: 'Allergies', exact: true })).toBeVisible()
  await expect(body).not.toContainText('Messages are not for urgent needs')
  // Typed URLs answer "Page not found", never a page of sample records.
  for (const [path] of HIDDEN) {
    await page.goto(`${PORTAL}${path}`)
    await expect(page.getByRole('heading', { name: 'Page not found' }), path).toBeVisible()
  }
})
