import { readFileSync } from 'node:fs'

import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'

import { stateFile, type Account } from './signIn.setup'

// Shared steps for the demo audit. A section must be ready, or (for a screen not built yet) show
// the shared "Work in progress" screen; it is never broken, empty or an error. Checks are soft, so
// one run reports every section, each with a screenshot under audit-results/.

/** What a broken screen says (an unknown route, an error panel, a failed read). */
export const BROKEN = /No screen at this address|Something went wrong|could not be read|Couldn't load|Not available yet/i
export const API = '/api/v1'

/** Sign in as a demo account (its session cookies from signIn.setup.ts) and open `path`. */
export async function as(page: Page, who: Account, path: string): Promise<void> {
  const state = JSON.parse(readFileSync(stateFile(who), 'utf8')) as {
    cookies: Parameters<BrowserContext['addCookies']>[0]
  }
  await page.context().clearCookies()
  await page.context().addCookies(state.cookies)
  await page.goto(path)
  await page.waitForLoadState('networkidle')
}

/** No error or missing screen, and a full-page screenshot named after the step. */
export async function screenOk(page: Page, name: string): Promise<void> {
  await expect.soft(page.getByText(BROKEN), `${name}: no error or missing screen`).toHaveCount(0)
  await page.screenshot({ path: `audit-results/${name}.png`, fullPage: true })
}

/** Ready (the landmark shows) or the shared "Work in progress" screen. */
export async function readyOrWip(page: Page, name: string, ready: Locator): Promise<void> {
  const wip = page.getByText(/Work in progress/i)
  await expect.soft(ready.or(wip).first(), `${name}: ready or Work in progress`).toBeVisible({ timeout: 15_000 })
  await screenOk(page, name)
}

/** The headers an unsafe API call needs, as the screens send them: the session's CSRF token and an
 *  allowed Origin (core refuses a write without both; Playwright's request context sends no Origin). */
export async function unsafe(page: Page): Promise<Record<string, string>> {
  return { 'X-CSRF-Token': await csrf(page), Origin: new URL(page.url()).origin }
}

/** The signed-in session's CSRF token, for the API reads that are POSTs (patient search, D13). */
export async function csrf(page: Page): Promise<string> {
  const res = await page.request.get(`${API}/auth/session`)
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()) as { csrfToken: string }).csrfToken
}

/** Linda Thompson's patient ID, by the typed search the desk uses (D117). */
export async function lindaId(page: Page): Promise<string> {
  const res = await page.request.post(`${API}/patients/search`, {
    headers: await unsafe(page),
    data: { criteria: { query: 'Thompson Linda' }, limit: 10 },
  })
  expect(res.status(), await res.text()).toBe(200)
  const items = ((await res.json()) as { items: { id: string }[] }).items
  expect(items.length, 'Linda Thompson is in the demo seed').toBeGreaterThan(0)
  return items[0].id
}

/** Today's appointment for the patient (the clinic's day), with its encounter once checked in. */
export async function todaysVisit(page: Page, patientId: string): Promise<{ id: string; status: string; encounterId?: string } | undefined> {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date())
  const res = await page.request.get(`${API}/appointments?date=${day}&limit=100`)
  expect(res.status(), await res.text()).toBe(200)
  const items = ((await res.json()) as { items: { id: string; status: string; encounterId?: string; patient: { id: string } }[] }).items
  return items.find((a) => a.patient.id === patientId)
}

/** The patient's open visit today (checked in by step 2), from the patient's own encounters. */
export async function openEncounter(page: Page, patientId: string): Promise<string | undefined> {
  const res = await page.request.get(`${API}/patients/${patientId}/encounters?limit=25`)
  if (res.status() !== 200) return undefined
  const items = ((await res.json()) as { items: { id: string; status: string }[] }).items
  return items.find((e) => !['finished', 'cancelled', 'entered-in-error'].includes(e.status))?.id
}
