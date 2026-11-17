import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { as, lindaId, openEncounter, readyOrWip, screenOk, speaking, unsafe } from './audit'

// The demo's exception paths (Sena's plan): a duplicate registration, a medication allergy alert,
// and a physician editing an AI-drafted note. On the demo-audit stack, as the demo accounts.
// Synthetic data only. The AI runs on the gateway's stub in CI (no key), so drafts are canned.

// Not serial: one failing step must not hide the rest of the audit. One worker runs the file
// in order, so the IDs found by the earlier steps carry over.
test.describe.configure({ mode: 'default' })

test('A. Registering Linda again warns about a possible duplicate', async ({ page }) => {
  // The rule, through the API the form calls: the same name and birth date is a 409
  // possible-duplicate naming her chart. The form is the front office's 11-step wizard; its full
  // walk to the "Register anyway" panel needs Minalini's selectors (run 2 found "DOB *", not
  // "Date of birth"), so the screen is only checked to load here.
  await as(page, 'frontdesk', '/register/new')
  await readyOrWip(page, 'A-register', page.getByRole('heading', { name: 'Registration Form' }))
  const id = await lindaId(page)
  const chart = (await (await page.request.get(`/api/v1/patients/${id}`)).json()) as {
    name: { family: string; given: string[] }; birthDate: string
  }
  const again = await page.request.post('/api/v1/patients', {
    headers: { ...(await unsafe(page)), 'Idempotency-Key': randomUUID() },
    data: { name: { family: chart.name.family, given: chart.name.given }, birthDate: chart.birthDate },
  })
  expect.soft(again.status(), 'the duplicate check answers 409').toBe(409)
  const body = (await again.json()) as { code?: string; candidateIds?: string[] }
  expect.soft(body.code, 'possible-duplicate').toBe('possible-duplicate')
  expect.soft(body.candidateIds ?? [], 'it names her chart').toContain(id)
})

test("B. Prescribing a drug she can't take raises the allergy alert", async ({ page }) => {
  await as(page, 'doctor', '/clinician/')
  const encounter = await openEncounter(page, await lindaId(page))
  test.skip(!encounter, 'needs Linda checked in (1-linda.audit.ts step 2 runs first)')
  await page.goto(`/clinician/encounter/${encounter}/rx`)
  await page.getByLabel('Search the formulary').fill('codeine')
  await expect.soft(page.getByLabel('Formulary matches').getByRole('button').first(), 'codeine is found').toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Formulary matches').getByRole('button').first().click()
  // Her chart records a codeine intolerance (the seed's alert scenario): the safety check says so.
  await expect.soft(page.getByText(/allerg|intoleran/i).first(), 'the allergy alert').toBeVisible({ timeout: 30_000 })
  await screenOk(page, 'B-allergy-alert')
})

test('C. Editing an AI-drafted note section', async ({ page }) => {
  await as(page, 'doctor', '/clinician/')
  const encounter = await openEncounter(page, await lindaId(page))
  test.skip(!encounter, 'needs Linda checked in (1-linda.audit.ts step 2 runs first)')
  // Run 4: the dictation sheet drafts only from what it heard; the runner has no microphone.
  await speaking(page, 'Low back pain for two weeks, worse when sitting. No fever. Continue naproxen with food.')
  await page.goto(`/clinician/encounter/${encounter}/note`)
  await readyOrWip(page, 'C-note', page.getByRole('button', { name: 'Draft with AI' }).first())
  await page.getByRole('button', { name: 'Draft with AI' }).first().click()
  await expect.soft(page.getByText(/Low back pain for two weeks/).first(), 'the sheet heard the dictation').toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Draft with AI' }).last().click()
  await expect.soft(page.getByRole('button', { name: /Accept/ }).first(), 'AI sections to decide').toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await expect.soft(page.locator('textarea:focus'), 'the section opens for editing').toBeVisible()
  await screenOk(page, 'C-ai-edit')
})
