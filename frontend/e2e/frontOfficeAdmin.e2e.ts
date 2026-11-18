import { expect, test } from '@playwright/test'

import { frontOfficeAdminPort, frontOfficePort } from '../playwright.config'

// The front office's Administration area (section 8 of the demo plan; Vimal on #85, 18 Nov): only
// the administrator sees it in the menu; Users and roles, the FHIR view and partner messages read
// the real API (#402), read only; the front desk has no entry and the address says so. Synthetic
// data only.

const ADMIN = `http://localhost:${frontOfficeAdminPort}`
const DESK = `http://localhost:${frontOfficePort}`

test('the administrator opens Administration from the menu and reads users and roles', async ({ page }) => {
  await page.goto(`${ADMIN}/`)
  await page.getByRole('link', { name: 'Administration' }).first().click()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.getByRole('heading', { name: 'Administration' }).first()).toBeVisible()
  await expect(page.getByRole('table', { name: 'Roles' }).or(page.getByText('Front desk')).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Couldn't read/)).toHaveCount(0)
})

test('partner messages and the FHIR view open for the administrator', async ({ page }) => {
  await page.goto(`${ADMIN}/admin/integrations`)
  await expect(page.getByText('Partner messages').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Couldn't read/)).toHaveCount(0)
  await page.goto(`${ADMIN}/admin/fhir`)
  await expect(page.getByText('Find the patient')).toBeVisible()
})

test('the front desk has no Administration entry, and the address says so', async ({ page }) => {
  await page.goto(`${DESK}/`)
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0)
  await page.goto(`${DESK}/admin`)
  await expect(page.getByText("Administration is for the clinic's administrator")).toBeVisible()
})
