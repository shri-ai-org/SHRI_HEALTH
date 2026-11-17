import { expect, test } from '@playwright/test'

import { as, lindaId, readyOrWip, screenOk, todaysVisit } from './audit'

// The demo's exception paths (Sena's plan): a duplicate registration, a medication allergy alert,
// and a physician editing an AI-drafted note. On the demo-audit stack, as the demo accounts.
// Synthetic data only. The AI runs on the gateway's stub in CI (no key), so drafts are canned.

test.describe.configure({ mode: 'serial' })

test('A. Registering Linda again warns about a possible duplicate', async ({ page }) => {
  await as(page, 'frontdesk', '/register/new')
  await readyOrWip(page, 'A-register', page.getByRole('button', { name: /Register/i }).first())
  await page.getByLabel(/First name/i).first().fill('Linda')
  await page.getByLabel(/Last name/i).first().fill('Thompson')
  // Her date of birth from the chart, so the duplicate check has something to match.
  const id = await lindaId(page)
  const chart = await page.request.get(`/api/v1/patients/${id}`)
  const birthDate = ((await chart.json()) as { birthDate: string }).birthDate
  const [y, m, d] = birthDate.split('-')
  await page.getByLabel(/Date of birth/i).first().fill(`${m}/${d}/${y}`)
  await page.getByRole('button', { name: /Register/i }).first().click()
  await expect.soft(page.getByText(/may already be registered|possible duplicate/i).first(), 'the duplicate warning').toBeVisible({ timeout: 15_000 })
  await screenOk(page, 'A-duplicate')
})

test("B. Prescribing a drug she can't take raises the allergy alert", async ({ page }) => {
  await as(page, 'doctor', '/clinician/')
  const visit = await todaysVisit(page, await lindaId(page))
  test.skip(!visit?.encounterId, 'needs Linda checked in (1-linda.audit.ts step 2 runs first)')
  await page.goto(`/clinician/encounter/${visit!.encounterId}/rx`)
  await page.getByLabel('Search the formulary').fill('codeine')
  await expect.soft(page.getByLabel('Formulary matches').getByRole('button').first(), 'codeine is found').toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Formulary matches').getByRole('button').first().click()
  // Her chart records a codeine intolerance (the seed's alert scenario): the safety check says so.
  await expect.soft(page.getByText(/allerg|intoleran/i).first(), 'the allergy alert').toBeVisible({ timeout: 30_000 })
  await screenOk(page, 'B-allergy-alert')
})

test('C. Editing an AI-drafted note section', async ({ page }) => {
  await as(page, 'doctor', '/clinician/')
  const visit = await todaysVisit(page, await lindaId(page))
  test.skip(!visit?.encounterId, 'needs Linda checked in (1-linda.audit.ts step 2 runs first)')
  await page.goto(`/clinician/encounter/${visit!.encounterId}/note`)
  await readyOrWip(page, 'C-note', page.getByRole('button', { name: 'Draft with AI' }).first())
  await page.getByRole('button', { name: 'Draft with AI' }).first().click()
  // The dictation sheet: type instead of speaking (the audit has no microphone).
  const dictation = page.getByRole('textbox').last()
  if (await dictation.isVisible()) await dictation.fill('Low back pain for two weeks, worse when sitting. No fever.')
  await page.getByRole('button', { name: 'Draft with AI' }).last().click()
  await expect.soft(page.getByRole('button', { name: /Accept/ }).first(), 'AI sections to decide').toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await expect.soft(page.locator('textarea:focus'), 'the section opens for editing').toBeVisible()
  await screenOk(page, 'C-ai-edit')
})
