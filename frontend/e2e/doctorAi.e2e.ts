import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'

// The doctors' portal's AI on the real API, with the AI service stubbed at the browser (no model,
// no key, no cost): "Draft with AI" (AI-01, createNoteDraft), the record's chart summary (AI-02) and
// the assistant's chart questions (D70). Everything else is the real API: the front desk registers,
// books and checks in a synthetic patient first. The stubs answer exactly as the contract does.
// The scribe hears through a stand-in for the browser's speech recognition. Synthetic data only.

const DOCTORS_URL = 'http://localhost:5191'
const surname = () => `Testai${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`
const NOW = new Date().toISOString()
const DICTATION = 'Patient reports three days of cough without fever. Lungs are clear. Likely viral bronchitis. Fluids and rest.'

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
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: facility.timeZone }).format(new Date())
  const types = await ok<{ items: { id: string }[] }>(await desk.get('/api/v1/booking/appointment-types'))
  const appointmentTypeId = types.items[0].id
  const slots = await ok<{ items: { providerId: string; startAt: string; overbook?: boolean }[] }>(
    await desk.get(`/api/v1/slots?date=${today}&facilityId=${facility.id}&appointmentTypeId=${appointmentTypeId}&limit=100`))
  const slot = slots.items.find((s) => !s.overbook && new Date(s.startAt) > new Date())
  expect(slot, 'a free slot later today').toBeTruthy()
  const appointment = await ok<{ id: string }>(await desk.post('/api/v1/appointments', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { patientId: patient.id, providerId: slot!.providerId, facilityId: facility.id, appointmentTypeId, startAt: slot!.startAt },
  }), 201)
  const checkIn = await ok<{ encounterId: string }>(await desk.post(`/api/v1/appointments/${appointment.id}/check-in`,
    { headers: { 'Idempotency-Key': randomUUID() }, data: { selfPay: true } }))
  return { encounterId: checkIn.encounterId, patientId: patient.id }
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: status >= 400 ? 'application/problem+json' : 'application/json', headers, body: JSON.stringify(body) })

/** A finished operation, as the AI gateway returns it in the 202. */
const operation = (kind: string, type: string, id: string) => ({ id: randomUUID(), kind, status: 'succeeded', createdAt: NOW, updatedAt: NOW, completedAt: NOW, result: { type, id } })

/** The browser's speech recognition and microphone, standing in for a clinician speaking. */
async function hearing(page: Page, words: string) {
  await page.addInitScript((said: string) => {
    class StandInRecognition {
      lang = 'en-US'
      continuous = true
      interimResults = true
      maxAlternatives = 1
      onresult: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      onend: (() => void) | null = null
      start() {
        setTimeout(() => {
          const result = Object.assign([{ transcript: said, confidence: 0.92 }], { isFinal: true })
          this.onresult?.({ resultIndex: 0, results: [result] })
        }, 150)
      }
      stop() {
        setTimeout(() => this.onend?.(), 10)
      }
      abort() {}
    }
    // Runs in the page; the e2e project has no DOM types, so the browser's globals are typed here.
    const g = globalThis as unknown as {
      navigator: { mediaDevices: { getUserMedia: () => Promise<unknown> } }
      AudioContext: new () => { createMediaStreamDestination: () => { stream: unknown } }
    }
    Object.assign(globalThis, { SpeechRecognition: StandInRecognition, webkitSpeechRecognition: StandInRecognition })
    g.navigator.mediaDevices.getUserMedia = async () => new g.AudioContext().createMediaStreamDestination().stream
  }, words)
}

const SECTIONS = [
  { code: '61150-9', title: 'Subjective', text: 'Three days of cough, no fever.' },
  { code: '61149-1', title: 'Objective', text: 'Lungs clear on auscultation.' },
  { code: '51848-0', title: 'Assessment', text: 'Likely viral bronchitis.' },
  { code: '18776-5', title: 'Plan', text: 'Fluids and rest; return if fever.' },
]

test('"Draft with AI" sends the dictation and shows four AI sections to accept, edit or reject', async ({ page, request }) => {
  const { encounterId, patientId } = await checkedInVisit(request)
  const noteId = randomUUID()
  const note = {
    id: noteId, encounterId, patientId, noteType: { codings: [], text: 'Progress note' }, title: 'SOAP', status: 'preliminary',
    cosignStatus: 'not-required', author: { id: randomUUID(), displayName: 'Rowan Test' }, aiAssisted: true, addenda: [],
    createdAt: NOW, updatedAt: NOW,
    sections: SECTIONS.map((s, i) => {
      const suggestion = randomUUID()
      return {
        id: randomUUID(), code: s.code, title: s.title, sequence: i + 1, required: true, text: s.text, entrySource: 'ai-generated',
        aiSuggestionId: suggestion, aiDecision: 'pending',
        aiSuggestion: { id: suggestion, feature: 'ambient-documentation', targetType: 'note-section', targetId: noteId, noteId, patientId,
                        confidence: 'high', rationale: 'From the dictation.', suggestedText: s.text, decision: 'pending' },
      }
    }),
  }
  let sentDictation: string | undefined
  await page.route('**/api/v1/ai/note-drafts', (route) => {
    sentDictation = (route.request().postDataJSON() as { dictation?: string }).dictation
    return json(route, 202, operation('ai.note-draft', 'note', noteId), { Location: `/api/v1/operations/${randomUUID()}` })
  })
  await page.route(`**/api/v1/notes/${noteId}`, (route) => json(route, 200, note, { ETag: '"1"' }))
  await hearing(page, DICTATION)

  await page.goto(`${DOCTORS_URL}/encounter/${encounterId}/note`)
  await page.getByRole('button', { name: 'Draft with AI' }).first().click()
  await expect(page.getByText(DICTATION.split('.')[0], { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Draft with AI' }).last().click()

  await expect(page.getByText('Four sections drafted by AI')).toBeVisible()
  expect(sentDictation).toContain('three days of cough')
  await expect(page.getByRole('region', { name: /Assessment — AI draft/ })).toHaveText('Likely viral bronchitis.')
  await expect(page.getByRole('region', { name: /Plan — AI draft/ })).toHaveText('Fluids and rest; return if fever.')
  await expect(page.getByRole('button', { name: /Accept/ }).first()).toBeVisible()
})

test('the chart summary links each statement to its record', async ({ page, request }) => {
  const { patientId } = await checkedInVisit(request)
  const summaryId = randomUUID()
  const conditionId = randomUUID()
  await page.route('**/api/v1/ai/chart-summaries', (route) => json(route, 202, operation('ai.chart-summary', 'chart-summary', summaryId)))
  await page.route(`**/api/v1/ai/chart-summaries/${summaryId}`, (route) => json(route, 200, {
    id: summaryId, patientId, createdAt: NOW,
    sections: [{ topic: 'diagnoses', statements: [{ sequence: 1, text: 'Essential hypertension, on the problem list since 2019.', confidence: 'high', sourceStatus: 'sourced',
                                                    sources: [{ resourceType: 'Condition', resourceId: conditionId, label: 'Essential hypertension' }] }] }],
    missing: [{ topic: 'results', description: 'No lab results in the chart.' }],
    suggestion: { id: randomUUID(), feature: 'chart-summary', targetType: 'chart-summary', targetId: summaryId, patientId, confidence: 'high', rationale: 'Chart summary.', decision: 'pending' },
  }))

  await page.goto(`${DOCTORS_URL}/patient/${patientId}/record`)
  await page.getByRole('button', { name: 'Summarize the chart' }).click()
  await expect(page.getByText('Essential hypertension, on the problem list since 2019.')).toBeVisible()
  await expect(page.getByText('No lab results in the chart.')).toBeVisible()
  await expect(page.getByText('AI-generated')).toBeVisible()
  await page.getByRole('button', { name: 'Source: Essential hypertension' }).click()
  await expect(page).toHaveURL(new RegExp(`/patient/${patientId}/condition$`))
})

test('the assistant answers from the chart with sources, or says it is not in the chart', async ({ page, request }) => {
  const { patientId } = await checkedInVisit(request)
  const answers = [
    { insufficientEvidence: false, statements: [{ sequence: 1, text: 'Lisinopril 10 mg once daily.', sources: [{ resourceType: 'MedicationRequest', resourceId: randomUUID(), label: 'Lisinopril 10 mg' }] }] },
    { insufficientEvidence: true, statements: [] },
  ]
  const asked: string[] = []
  await page.route('**/api/v1/ai/suggested-questions*', (route) => json(route, 200, { pageType: 'chart', questions: ['What medications is this patient on?'] }))
  await page.route('**/api/v1/ai/chart-questions', (route) => {
    asked.push((route.request().postDataJSON() as { question: string }).question)
    return json(route, 202, operation('ai.chart-question', 'chart-answer', `answer-${asked.length}`))
  })
  await page.route('**/api/v1/ai/chart-answers/*', (route) => {
    const n = Number(route.request().url().split('answer-')[1]) - 1
    return json(route, 200, { id: randomUUID(), patientId, pageType: 'chart', question: asked[n], aiGenerated: true, createdAt: NOW,
                              generatedBy: { modelName: 'Claude (stub)', pipelineVersion: 'test' }, ...answers[n] })
  })

  await page.goto(`${DOCTORS_URL}/patient/${patientId}/record`)
  await page.getByRole('button', { name: 'Assistant' }).click()
  await page.getByRole('button', { name: 'What medications is this patient on?' }).click()
  await expect(page.getByText('Lisinopril 10 mg once daily.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Source: Lisinopril 10 mg' })).toBeVisible()
  await page.getByLabel('Ask the assistant').fill('Has the patient ever had surgery?')
  await page.getByRole('button', { name: 'Ask' }).click()
  await expect(page.getByText('Not in the chart.')).toBeVisible()
  expect(asked).toEqual(['What medications is this patient on?', 'Has the patient ever had surgery?'])
})

test('with AI off for the clinic, the summary card leaves the record and the record still works', async ({ page, request }) => {
  const { patientId } = await checkedInVisit(request)
  await page.route('**/api/v1/ai/chart-summaries', (route) => json(route, 409, {
    type: 'about:blank', title: 'Conflict', status: 409, code: 'feature-disabled', detail: 'AI is off for this clinic.' }))
  await page.goto(`${DOCTORS_URL}/patient/${patientId}/record`)
  await page.getByRole('button', { name: 'Summarize the chart' }).click()
  await expect(page.getByRole('button', { name: 'Summarize the chart' })).toHaveCount(0)
  await expect(page.getByText('AI chart summary')).toHaveCount(0)
})
