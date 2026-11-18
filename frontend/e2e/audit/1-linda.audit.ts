import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { API, as, lindaId, readyOrWip, screenOk, todaysVisit, unsafe } from './audit'

// Sena's demo flow for Linda Thompson (the 16 Nov plan on #85; D119), on the stack the demo-audit
// job builds like the demo server. A step whose screen isn't merged yet is skipped with the reason,
// so the job runs now and each step turns on as its screen lands (remove its `test.skip`).
// Synthetic data only.

// Not serial: one failing step must not hide the rest of the audit. One worker runs the file
// in order, so the IDs found by the earlier steps carry over.
test.describe.configure({ mode: 'default' })

let patientId = ''
let appointmentId = ''
let encounterId = ''

test('1. The front desk finds Linda from a few typed letters', async ({ page }) => {
  await as(page, 'frontdesk', '/patients/search')
  patientId = await lindaId(page)
  // The header's typed search (run 2: a combobox named "Search patients").
  const search = page.getByRole('combobox', { name: 'Search patients' }).first()
  await search.fill('Thomp')
  await expect.soft(page.getByText(/Thompson,? Linda|Linda Thompson/).first(), 'Linda is listed').toBeVisible({ timeout: 15_000 })
  await screenOk(page, '01-search')
})

test('1b. Registration has the consent checkbox', async () => {
  test.skip(true, "waits for Minalini's consent checkbox (createPatient consents[], PR 398)")
})

test("2. Check-in from today's outpatients", async ({ page }) => {
  await as(page, 'frontdesk', '/patients/outpatients')
  const visit = await todaysVisit(page, patientId)
  expect(visit, "Linda is booked on the clinic's day (the reset after 13:30 IST)").toBeTruthy()
  appointmentId = visit!.id
  const row = page.getByRole('listitem').filter({ hasText: /Thompson/ }).first()
  await expect.soft(row, "Linda's row on Outpatients").toBeVisible({ timeout: 15_000 })
  await screenOk(page, '02-outpatients')
  if (visit!.encounterId) {
    encounterId = visit!.encounterId
    return
  }
  // The audit checks the screen, then checks in through the API so the later steps have a visit.
  await expect.soft(row.getByRole('button', { name: /Check in/i }), 'Check in is offered').toBeVisible()
  const res = await page.request.post(`${API}/appointments/${appointmentId}/check-in`, {
    headers: { 'Idempotency-Key': randomUUID(), ...(await unsafe(page)) },
    data: { selfPay: true },
  })
  expect(res.status(), await res.text()).toBe(200)
  encounterId = ((await res.json()) as { encounterId: string }).encounterId
})

test('3. The medical assistant rooms Linda', async ({ page }) => {
  await as(page, 'ma', `/patients/outpatients?flow=rooming&appointment=${appointmentId}`)
  await readyOrWip(page, '03-rooming', page.locator('#rooming-allergy').or(page.getByText(/Vitals/i)).first())
})

test("4. The doctor's chart: record, at a glance, History, Previous Visits", async ({ page }) => {
  await as(page, 'doctor', `/clinician/patient/${patientId}/record`)
  await readyOrWip(page, '04-record', page.getByText(/At a glance/i).first())
  await expect.soft(page.getByText(/History/i).first(), 'History is on the record').toBeVisible()
  await as(page, 'doctor', `/clinician/patient/${patientId}/appointments`)
  await expect.soft(page.getByText('Previous Visits').first(), 'Previous Visits').toBeVisible()
  await screenOk(page, '04-previous-visits')
})

test('5. Results with graphs over time', async ({ page }) => {
  await as(page, 'doctor', `/clinician/patient/${patientId}/reports`)
  await readyOrWip(page, '05-results', page.getByRole('list', { name: 'Tests over time' }).or(page.locator('svg')).first())
})

test('6. Imaging with its illustrative image', async () => {
  test.skip(true, "waits for Minalini's imaging viewer (images on reports: PR 387, PR 393)")
})

test('7. The AI visit summary: Accept, Edit or Reject', async () => {
  test.skip(true, "waits for Minalini's AI summary block (backend merged: PR 396, PR 397, PR 406)")
})

test('8. ICD-10 suggestions, accepted or rejected one by one', async () => {
  test.skip(true, "waits for Minalini's ICD-10 chips (backend merged: PR 396, PR 404)")
})

test('9. A prescription', async ({ page }) => {
  await as(page, 'doctor', `/clinician/encounter/${encounterId}/rx`)
  await readyOrWip(page, '09-rx', page.getByLabel('Search the formulary'))
})

test('10. A follow-up request', async ({ page }) => {
  await as(page, 'doctor', `/clinician/encounter/${encounterId}/follow-up`)
  await readyOrWip(page, '10-follow-up', page.getByRole('heading', { name: /follow-up/i }).first())
})

test('11. Check-out at the desk', async ({ page }) => {
  await as(page, 'frontdesk', '/patients/outpatients')
  const row = page.getByRole('listitem').filter({ hasText: /Thompson/ }).first()
  await expect.soft(row.getByRole('button', { name: /Check out/i }).or(row.getByText(/Checked in|Roomed/i)).first(),
    'Linda is checked in, with check-out ahead').toBeVisible({ timeout: 15_000 })
  await screenOk(page, '11-check-out')
})

test('12. Portal: her visit summaries', async () => {
  test.skip(true, 'waits for the portal visit summaries (PR 395) and its page')
})

test('13. Portal: her lab results', async () => {
  test.skip(true, "waits for Anand's portal lab results (PR 408) and Minalini's page")
})

test('14. Portal: her medications, read only', async ({ page }) => {
  await as(page, 'linda', '/portal/prescriptions')
  await readyOrWip(page, '14-portal-medications', page.getByRole('list', { name: 'Your medications' }))
  await expect.soft(page.getByText(/omeprazole/i).first(), 'the refill-ready omeprazole is listed').toBeVisible()
})

test('14b. Portal: a refill request', async () => {
  test.skip(true, "waits for refill requests (contract PR 400, then Thulasi's backend and the page)")
})

test('15. Billing shows Work in progress', async ({ page }) => {
  await as(page, 'frontdesk', '/payments')
  await expect.soft(page.getByText(/Work in progress/i).first(), 'billing is Work in progress').toBeVisible()
  await screenOk(page, '15-billing-wip')
})

test('16. Orders and referrals show Work in progress (after the demo; checked in 3-wip.audit.ts)', async ({ page }) => {
  await as(page, 'doctor', '/clinician/orders/sets')
  await expect.soft(page.getByText(/This feature is work in progress/i).first(), 'orders are Work in progress').toBeVisible({ timeout: 15_000 })
  await screenOk(page, '16-orders-wip')
})

test('17. Administration: users and roles, FHIR view, partner messages (read only)', async ({ page }) => {
  await as(page, 'admin', '/')
  await expect(page.getByRole('link', { name: 'Administration' }).first(), 'Administration is in the menu').toBeVisible({ timeout: 15_000 })
  await as(page, 'admin', '/admin/users')
  await expect.soft(page.getByText('Front desk').first(), 'the roles are listed').toBeVisible({ timeout: 15_000 })
  await screenOk(page, '17-admin-users')
  await as(page, 'admin', '/admin/integrations')
  await expect.soft(page.getByText('Partner messages').first(), 'partner messages open').toBeVisible({ timeout: 15_000 })
  await screenOk(page, '17-admin-integrations')
  await as(page, 'admin', '/admin/fhir')
  await page.getByLabel('Patient', { exact: true }).fill('Thomp')
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('button', { name: /Thompson/ }).first().click()
  await expect.soft(page.getByText(/FHIR R4 record/).first(), "Linda's FHIR record opens").toBeVisible({ timeout: 15_000 })
  await expect.soft(page.getByLabel('Resources by type').getByText(/Patient/), 'it holds her Patient resource').toBeVisible()
  await screenOk(page, '17-admin-fhir')
})

test('17b. The front desk has no Administration entry', async ({ page }) => {
  await as(page, 'frontdesk', '/')
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0)
})
