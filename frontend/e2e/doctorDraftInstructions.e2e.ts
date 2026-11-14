import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'

import { nextSlotToday } from './nextSlot'

// Vimal's rehearsal, 14 Nov: after "Draft with AI" and accepting every section, Sign was refused.
// The SOAP template's fifth section, the patient instructions (LOINC 69730-0, D73), was drafted
// too, but the note never showed it, so its AI suggestion had no decision. The note now shows it
// (optional) with the same Accept, Edit or Reject, and a refused Sign names its section. The real
// API for the visit; the AI service, the decisions and Sign are stubbed at the browser as the
// contract answers (no model, no key, no cost). Synthetic data only.

const DOCTORS_URL = 'http://localhost:5191'
const surname = () => `Testdr${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`
const NOW = new Date().toISOString()
const TAKE = 'Three days of cough without fever. Lungs are clear. Likely viral bronchitis. Fluids and rest, call if a fever starts.'

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

/** Register, book the next free slot today and check in, as the front desk: the visit and its patient. */
async function checkedInVisit(desk: APIRequestContext): Promise<{ encounterId: string; patientId: string }> {
  const patient = await ok<{ id: string }>(await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: surname(), given: ['Rowan'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  }), 201)
  const facilities = await ok<{ items: { id: string; timeZone: string }[] }>(await desk.get('/api/v1/booking/facilities'))
  const facility = facilities.items[0]
  const types = await ok<{ items: { id: string }[] }>(await desk.get('/api/v1/booking/appointment-types'))
  const appointmentTypeId = types.items[0].id
  const slot = await nextSlotToday(desk, facility, appointmentTypeId)
  const appointment = await ok<{ id: string }>(await desk.post('/api/v1/appointments', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { patientId: patient.id, providerId: slot.providerId, facilityId: facility.id, appointmentTypeId, startAt: slot.startAt, ...(slot.overbook ? { overbook: true } : {}) },
  }), 201)
  const checkIn = await ok<{ encounterId: string }>(await desk.post(`/api/v1/appointments/${appointment.id}/check-in`,
    { headers: { 'Idempotency-Key': randomUUID() }, data: { selfPay: true } }))
  return { encounterId: checkIn.encounterId, patientId: patient.id }
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: status >= 400 ? 'application/problem+json' : 'application/json', headers, body: JSON.stringify(body) })

/** The browser's recogniser and microphone: each scribe session hears the next take. */
async function hearing(page: Page, takes: string[]) {
  await page.addInitScript((said: string[]) => {
    let sessions = 0
    class StandInRecognition {
      lang = 'en-US'
      continuous = true
      interimResults = true
      maxAlternatives = 1
      onresult: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      onend: (() => void) | null = null
      private readonly words = said[Math.min(sessions++, said.length - 1)]
      start() {
        setTimeout(() => {
          const result = Object.assign([{ transcript: this.words, confidence: 0.92 }], { isFinal: true })
          this.onresult?.({ resultIndex: 0, results: [result] })
        }, 150)
      }
      stop() {
        setTimeout(() => this.onend?.(), 10)
      }
      abort() {}
    }
    const g = globalThis as unknown as {
      navigator: { mediaDevices: { getUserMedia: () => Promise<unknown> } }
      AudioContext: new () => { createMediaStreamDestination: () => { stream: unknown } }
    }
    Object.assign(globalThis, { SpeechRecognition: StandInRecognition, webkitSpeechRecognition: StandInRecognition })
    g.navigator.mediaDevices.getUserMedia = async () => new g.AudioContext().createMediaStreamDestination().stream
  }, takes)
}

const SECTIONS = [
  { code: '61150-9', title: 'Subjective', text: 'Three days of cough, no fever.' },
  { code: '61149-1', title: 'Objective', text: 'Lungs clear on auscultation.' },
  { code: '51848-0', title: 'Assessment', text: 'Likely viral bronchitis.' },
  { code: '18776-5', title: 'Plan', text: 'Fluids and rest; return if fever.' },
  { code: '69730-0', title: 'Patient instructions', text: 'Drink plenty of fluids and rest. Call us if you get a fever.' },
]

/** The AI's draft as the server returns it: all five template sections, each with a pending suggestion. */
function aiNote(encounterId: string, patientId: string) {
  const id = randomUUID()
  return {
    id, encounterId, patientId, noteType: { codings: [], text: 'Progress note' }, title: 'SOAP', status: 'preliminary',
    cosignStatus: 'not-required', author: { id: randomUUID(), displayName: 'Rowan Test' }, aiAssisted: true, addenda: [],
    createdAt: NOW, updatedAt: NOW,
    sections: SECTIONS.map((s, i) => {
      const suggestion = randomUUID()
      return {
        id: randomUUID(), code: s.code, title: s.title, sequence: i + 1, required: s.code !== '69730-0', text: s.text, entrySource: 'ai-generated',
        aiSuggestionId: suggestion, aiDecision: 'pending',
        aiSuggestion: { id: suggestion, feature: 'ambient-documentation', targetType: 'note-section', targetId: id, noteId: id, patientId,
                        confidence: 'high', rationale: 'From the dictation.', suggestedText: s.text, decision: 'pending' },
      }
    }),
  }
}

/** The AI stub and the decision route; returns the suggestions decided. */
async function draftedNote(page: Page, note: ReturnType<typeof aiNote>) {
  await page.route('**/api/v1/ai/note-drafts', (route) =>
    json(route, 202, { id: randomUUID(), kind: 'ai.note-draft', status: 'succeeded', createdAt: NOW, updatedAt: NOW, completedAt: NOW, result: { type: 'note', id: note.id } },
      { Location: `/api/v1/operations/${randomUUID()}` }))
  await page.route(`**/api/v1/notes/${note.id}`, (route) => json(route, 200, note, { ETag: '"1"' }))
  const decided: string[] = []
  await page.route('**/api/v1/ai/suggestions/*/decision', (route) => {
    decided.push(route.request().url().split('/suggestions/')[1].split('/')[0])
    return json(route, 200, {})
  })
  await page.route('**/api/v1/encounters/*/after-visit-summary', (route) =>
    json(route, 202, { id: randomUUID(), kind: 'after-visit-summary', status: 'queued', createdAt: NOW, updatedAt: NOW }))
  await hearing(page, [TAKE])
  return decided
}

async function draftAcceptAndCode(page: Page, encounterId: string) {
  await page.goto(`${DOCTORS_URL}/encounter/${encounterId}/note`)
  await page.getByRole('button', { name: 'Draft with AI' }).first().click()
  await expect(page.getByText(TAKE.split('.')[0], { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Draft with AI' }).last().click()
  await expect(page.getByText('5 sections drafted by AI')).toBeVisible()
  // The fifth section is on the note, with its own decision.
  await expect(page.getByRole('region', { name: /Patient instructions — AI draft/ })).toHaveText(SECTIONS[4].text)
  for (let i = 0; i < SECTIONS.length; i += 1) await page.getByRole('button', { name: 'Accept', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Search ICD-10' }).fill('hypertension')
  await page.getByRole('option').first().click({ timeout: 15_000 })
}

async function sign(page: Page) {
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: /^Sign/ })
  if (await confirm.count()) await confirm.click()
}

test('a note drafted with AI shows its patient instructions to decide, and signs once all five are decided', async ({ page, request }) => {
  const { encounterId, patientId } = await checkedInVisit(request)
  const note = aiNote(encounterId, patientId)
  const decided = await draftedNote(page, note)
  await page.route(`**/api/v1/notes/${note.id}/sign`, (route) =>
    json(route, 200, { ...note, status: 'final', signedAt: NOW, signedBy: { id: randomUUID(), displayName: 'Rowan Test' } }, { ETag: '"2"' }))
  await draftAcceptAndCode(page, encounterId)
  await sign(page)
  await expect(page.getByText('Note signed')).toBeVisible()
  // Every AI section was decided by the clinician's own Accept, the patient instructions included.
  expect(decided.sort()).toEqual(note.sections.map((s) => s.aiSuggestionId).sort())
})

test('a refused Sign names the section it is about', async ({ page, request }) => {
  const { encounterId, patientId } = await checkedInVisit(request)
  const note = aiNote(encounterId, patientId)
  await draftedNote(page, note)
  await page.route(`**/api/v1/notes/${note.id}/sign`, (route) => json(route, 422, {
    type: 'tag:company-domain.invalid,2026:problem/business-rule-violation', title: 'Business rule violation', status: 422,
    code: 'business-rule-violation', detail: 'The request breaks a business rule.',
    errors: [{ in: 'body', pointer: '/sections/4/aiDecision', code: 'required' }],
  }))
  await draftAcceptAndCode(page, encounterId)
  await sign(page)
  await expect(page.getByText('Patient instructions: the AI draft needs Accept, Edit or Reject.')).toBeVisible()
})
