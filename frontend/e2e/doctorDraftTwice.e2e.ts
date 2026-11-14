import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'

import { nextSlotToday } from './nextSlot'

// Vimal's rehearsal, 14 Nov: a second "Draft with AI" emptied the sections the first one filled.
// Now every dictation of the visit goes with each draft, in order, and a draft never empties or
// silently overwrites a section the doctor already has: an empty one is filled, a written one gets
// the new text only as an offer (Replace / Keep mine). The real API throughout, except the AI
// service, stubbed at the browser as the contract answers (no model, no key, no cost), and the
// browser's speech recognition, a stand-in that hears one take per scribe session. Synthetic data only.

const DOCTORS_URL = 'http://localhost:5191'
const surname = () => `Testdr${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`
const NOW = new Date().toISOString()
const TAKE_1 = 'Three days of cough without fever. Lungs are clear on listening.'
const TAKE_2 = 'Likely viral bronchitis. Fluids and rest, return if a fever starts.'

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

const CODES = { subjective: '61150-9', objective: '61149-1', assessment: '51848-0', plan: '18776-5' } as const
const TITLES = { subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan' } as const
type Key = keyof typeof CODES

/** A draft note as the server returns it: the AI's sections pending, the others empty. */
function draftNote(encounterId: string, patientId: string, ai: Partial<Record<Key, string>>) {
  const id = randomUUID()
  return {
    id, encounterId, patientId, noteType: { codings: [], text: 'Progress note' }, title: 'SOAP', status: 'preliminary',
    cosignStatus: 'not-required', author: { id: randomUUID(), displayName: 'Rowan Test' }, aiAssisted: true, addenda: [],
    createdAt: NOW, updatedAt: NOW,
    sections: (Object.keys(CODES) as Key[]).map((k, i) => {
      const text = ai[k]
      const base = { id: randomUUID(), code: CODES[k], title: TITLES[k], sequence: i + 1, required: true, text: text ?? '' }
      if (text === undefined) return { ...base, entrySource: 'clinician' }
      const suggestion = randomUUID()
      return {
        ...base, entrySource: 'ai-generated', aiSuggestionId: suggestion, aiDecision: 'pending',
        aiSuggestion: { id: suggestion, feature: 'ambient-documentation', targetType: 'note-section', targetId: id, noteId: id, patientId,
                        confidence: 'high', rationale: 'From the dictation.', suggestedText: text, decision: 'pending' },
      }
    }),
  }
}

test('a second "Draft with AI" keeps the first draft’s sections, sends all the dictation, and only offers new text for written sections', async ({ page, request }) => {
  const { encounterId, patientId } = await checkedInVisit(request)
  const S = 'Three days of cough, no fever.'
  const O = 'Lungs clear on auscultation.'
  const note1 = draftNote(encounterId, patientId, { subjective: S, objective: O })
  // The second draft heard everything: it suggests new subjective wording, and assessment and plan.
  const note2 = draftNote(encounterId, patientId, { subjective: 'Dry cough for three days.', assessment: 'Likely viral bronchitis.', plan: 'Fluids and rest; return if fever.' })
  const notes = [note1, note2]
  const sent: string[] = []
  await page.route('**/api/v1/ai/note-drafts', (route) => {
    sent.push((route.request().postDataJSON() as { dictation: string }).dictation)
    const n = notes[Math.min(sent.length - 1, 1)]
    return json(route, 202, { id: randomUUID(), kind: 'ai.note-draft', status: 'succeeded', createdAt: NOW, updatedAt: NOW, completedAt: NOW, result: { type: 'note', id: n.id } },
      { Location: `/api/v1/operations/${randomUUID()}` })
  })
  for (const n of notes) await page.route(`**/api/v1/notes/${n.id}`, (route) => json(route, 200, n, { ETag: '"1"' }))
  await hearing(page, [TAKE_1, TAKE_2])
  const section = (k: Key) => page.locator(`[id="${encounterId}:${k}"]`)

  await page.goto(`${DOCTORS_URL}/encounter/${encounterId}/note`)

  // Draft 1: subjective and objective, accepted.
  await page.getByRole('button', { name: 'Draft with AI' }).first().click()
  await expect(page.getByText(TAKE_1.split('.')[0], { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Draft with AI' }).last().click()
  await expect(page.getByText('2 sections drafted by AI')).toBeVisible()
  await expect(page.getByRole('region', { name: /Subjective — AI draft/ })).toHaveText(S)
  await page.getByRole('button', { name: 'Accept', exact: true }).first().click()
  await page.getByRole('button', { name: 'Accept', exact: true }).first().click()
  await expect(section('subjective')).toHaveValue(S)
  await expect(section('objective')).toHaveValue(O)

  // Draft 2: the earlier dictation is shown and sent again, in order, with the new take.
  await page.getByRole('button', { name: 'Draft with AI' }).first().click()
  await expect(page.getByText('Earlier dictation for this visit · 1 take')).toBeVisible()
  await expect(page.getByText(TAKE_2.split('.')[0], { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Draft with AI' }).last().click()
  await expect(page.getByText('3 sections drafted by AI')).toBeVisible()
  expect(sent).toHaveLength(2)
  expect(sent[0]).toBe(TAKE_1)
  expect(sent[1]).toBe(`${TAKE_1}\n${TAKE_2}`)

  // Subjective and objective are intact; assessment and plan are filled as AI drafts.
  await expect(section('subjective')).toHaveValue(S)
  await expect(section('objective')).toHaveValue(O)
  await expect(page.getByRole('region', { name: /Assessment — AI draft/ })).toHaveText('Likely viral bronchitis.')
  await expect(page.getByRole('region', { name: /Plan — AI draft/ })).toHaveText('Fluids and rest; return if fever.')

  // The accepted subjective is not overwritten: the new wording is only offered.
  const offer = page.getByRole('group', { name: 'New AI draft for Subjective' })
  await expect(offer).toContainText('Dry cough for three days.')
  await offer.getByRole('button', { name: 'Keep mine' }).click()
  await expect(offer).toHaveCount(0)
  await expect(section('subjective')).toHaveValue(S)

  // Clear dictation starts over: the next scribe session shows no earlier dictation.
  await page.getByRole('button', { name: 'Draft with AI' }).first().click()
  await page.getByRole('button', { name: 'Clear dictation' }).click()
  await expect(page.getByText(/Earlier dictation for this visit/)).toHaveCount(0)
})
