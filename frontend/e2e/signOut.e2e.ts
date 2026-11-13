import { expect, test, type Page } from '@playwright/test'

import { doctorsPort, frontOfficePort, portalPort } from '../playwright.config'

// Sign out from the user menu of each app, then another account signs in (demo run check,
// 12 Nov; src/api/session.tsx, features/portal/PortalApp.tsx). Sign out ends our session
// (POST /auth/logout, which ends the Keycloak session in core) and goes straight to the sign-in
// form. Keycloak's form is a stand-in page here; "signing in" as the next role is the session
// read answering for that role. Synthetic sessions only (fictional names, no patient data).

const DESK = `http://localhost:${frontOfficePort}`
const DOCTORS = `http://localhost:${doctorsPort}`
const SIGN_IN_FORM = '<!doctype html><meta charset="utf-8"><title>Sign in</title><h1>Keycloak sign-in stand-in</h1>'

async function sessionFor(page: Page, role: string) {
  // Far from any limit, so the idle warning never covers the app bar.
  const idle = new Date(Date.now() + 60 * 60_000).toISOString()
  const later = new Date(Date.now() + 12 * 60 * 60_000).toISOString()
  await page.unroute('**/api/v1/auth/session')
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'd0000000-0000-4000-8000-000000000098', displayName: `E2E ${role}`, roles: [role],
                facilityIds: ['fa000000-0000-4000-8000-00000000000a'] },
        organization: { id: '0a000000-0000-4000-8000-00000000000a', name: 'Dev Clinic A' },
        csrfToken: 'e2e',
        idleExpiresAt: idle,
        expiresAt: later,
        build: { version: 'e2e', commit: 'e2e' },
      }),
    }),
  )
}

/** The logout call (counted) and the sign-in form it leads to. */
async function signOutRoutes(page: Page, prefix = '/api/v1'): Promise<() => number> {
  let logouts = 0
  await page.route(`**${prefix}/auth/logout`, (route) => {
    logouts += 1
    return route.fulfill({ status: 204 })
  })
  await page.route(`**${prefix}/auth/login`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: SIGN_IN_FORM }))
  await page.route('**/clinician/', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Doctors</title><h1>Doctors portal stand-in</h1>' }))
  return () => logouts
}

test('front office: the front desk signs out, and the doctor signs in next', async ({ page }) => {
  const logouts = await signOutRoutes(page)
  await sessionFor(page, 'FD')
  await page.goto(`${DESK}/`)
  await page.getByRole('button', { name: /Signed in as E2E FD/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Keycloak sign-in stand-in' })).toBeVisible()
  await expect(page).toHaveURL(`${DESK}/api/v1/auth/login`)
  expect(logouts()).toBe(1)
  // The next account: the doctor, who lands in the doctors' portal.
  await sessionFor(page, 'MD')
  await page.goto(`${DESK}/`)
  await expect(page.getByRole('heading', { name: 'Doctors portal stand-in' })).toBeVisible()
})

test("doctors' portal: the doctor signs out, and the front desk signs in next", async ({ page }) => {
  const logouts = await signOutRoutes(page)
  await sessionFor(page, 'MD')
  await page.goto(`${DOCTORS}/`)
  await page.locator('button[aria-label$="user menu"]').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Keycloak sign-in stand-in' })).toBeVisible()
  await expect(page).toHaveURL(`${DOCTORS}/api/v1/auth/login`)
  expect(logouts()).toBe(1)
  // The next account: the front desk, on the front office.
  await sessionFor(page, 'FD')
  await page.goto(`${DESK}/`)
  await expect(page.getByText('Signed in as E2E FD')).toBeVisible()
})

test('patient portal: the patient signs out and the patient sign-in form opens', async ({ page }) => {
  test.skip(!process.env.SHRI_E2E_PORTAL_PATIENT, 'needs SHRI_E2E_PORTAL_PATIENT: the portal dev server runs only for a patient')
  const logouts = await signOutRoutes(page, '/api/v1/portal')
  const PORTAL = `http://localhost:${portalPort}`
  await page.goto(`${PORTAL}/portal/`)
  await page.getByRole('button', { name: /account menu/ }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Keycloak sign-in stand-in' })).toBeVisible()
  await expect(page).toHaveURL(`${PORTAL}/api/v1/portal/auth/login`)
  expect(logouts()).toBe(1)
})
