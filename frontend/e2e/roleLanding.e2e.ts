import { expect, test, type Page } from '@playwright/test'

import { frontOfficePort, portalPort } from '../playwright.config'

// Where each role lands (demo, 12 Nov; src/api/landing.tsx). The front office's session read is
// answered here with a synthetic session for each role (fictional names, no patient data), so one
// dev server covers every role; the rest of the app talks to the real API. A clinician-only role
// is forwarded to /clinician/ before the front office renders: the doctors' portal is answered
// with a stand-in page, and a watcher records whether the front office ever painted the user.

const DESK = `http://localhost:${frontOfficePort}`
const DEEP_LINK = '/patients/outpatients'

async function signedInAs(page: Page, role: string) {
  const later = new Date(Date.now() + 15 * 60_000).toISOString()
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'd0000000-0000-4000-8000-000000000099', displayName: `E2E ${role}`, roles: [role],
                facilityIds: ['fa000000-0000-4000-8000-00000000000a'] },
        organization: { id: '0a000000-0000-4000-8000-00000000000a', name: 'Dev Clinic A' },
        csrfToken: 'e2e',
        idleExpiresAt: later,
        expiresAt: later,
        build: { version: 'e2e', commit: 'e2e' },
      }),
    }),
  )
  await page.route('**/clinician/', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Doctors</title><h1>Doctors portal stand-in</h1>' }),
  )
  // Any paint of the front office names the user; remember it across the forward (same origin).
  // A script string, not a function: this file is type-checked without the DOM types.
  await page.addInitScript({
    content: `new MutationObserver(() => {
      if (document.body?.innerText.includes(${JSON.stringify(`E2E ${role}`)})) sessionStorage.setItem('e2e.frontOfficePainted', '1')
    }).observe(document, { childList: true, subtree: true, characterData: true })`,
  })
}

for (const role of ['MD', 'APP', 'RN']) {
  test(`${role} lands in the doctors' portal, with no flash of the front office`, async ({ page }) => {
    await signedInAs(page, role)
    await page.goto(`${DESK}${DEEP_LINK}`)
    await expect(page).toHaveURL(`${DESK}/clinician/`)
    await expect(page.getByRole('heading', { name: 'Doctors portal stand-in' })).toBeVisible()
    expect(await page.evaluate(() => sessionStorage.getItem('e2e.frontOfficePainted'))).toBeNull()
  })
}

for (const role of ['FD', 'MA', 'ADM']) {
  test(`${role} stays on the front office, deep links included`, async ({ page }) => {
    await signedInAs(page, role)
    await page.goto(`${DESK}/`)
    await expect(page.getByText(`Signed in as E2E ${role}`)).toBeVisible()
    await expect(page).toHaveURL(`${DESK}/`)
    await page.goto(`${DESK}${DEEP_LINK}`)
    await expect(page.getByText(`Signed in as E2E ${role}`)).toBeVisible()
    await expect(page).toHaveURL(`${DESK}${DEEP_LINK}`)
  })
}

test('a patient lands in the patient portal', async ({ page }) => {
  test.skip(!process.env.SHRI_E2E_PORTAL_PATIENT, 'needs SHRI_E2E_PORTAL_PATIENT: the portal dev server runs only for a patient')
  await page.goto(`http://localhost:${portalPort}/portal/`)
  await expect(page.getByRole('link', { name: 'Shri Health patient portal, home' })).toBeVisible()
  await expect(page).toHaveURL(`http://localhost:${portalPort}/portal/`)
})
