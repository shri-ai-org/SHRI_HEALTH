// The 20 November demo story (D95; contracts/docs/IMPL_BATCH1_PLAN.md §8): one complete patient visit across the
// patient, front-desk and clinician portals, step by step, as the sample-data server (or later the real API) answers it.
//
//   npm run mock                          (in another terminal; port 4010)
//   node tests/flows/demo-visit.mjs
//   BASE_URL=http://127.0.0.1:4020 node tests/flows/demo-visit.mjs
//
// Request bodies are the contract's own request examples, so the flow always sends what the contract accepts; IDs
// come from the previous answers. `Prefer: code=…` asks the mock for the documented refusals. Staff calls use a mock
// staff session, the portal steps a mock patient session, the public form none. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');
const BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), '../../openapi/dist/shri-health.bundled.yaml');
const contract = YAML.parse(readFileSync(BUNDLE, 'utf8'));
const SESSIONS = {
  staff: { Cookie: '__Host-shri_session=mock', 'X-CSRF-Token': 'mock' },
  patient: { Cookie: '__Host-shri_portal=mock', 'X-CSRF-Token': 'mock' },
  public: {},
};
const results = [];
let step = '';

/** The first request example the contract gives for an operation; undefined when it takes no body. */
function example(method, path, name) {
  const requestBody = contract.paths[path]?.[method.toLowerCase()]?.requestBody;
  if (!requestBody) return undefined;
  const content = requestBody.content ?? {};
  const media = Object.values(content)[0];
  const examples = media?.examples ?? {};
  const chosen = name ? examples[name] : Object.values(examples)[0];
  if (!chosen) throw new Error(`no request example for ${method} ${path}`);
  return structuredClone(chosen.value);
}

async function call(name, method, path, { as = 'staff', body, expect, prefer, headers = {} } = {}) {
  const url = path;
  const init = { method, redirect: 'manual', headers: { Accept: 'application/json, application/problem+json', ...SESSIONS[as], ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  if (prefer) init.headers.Prefer = `code=${prefer}`;
  const response = await fetch(`${BASE_URL}${url}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  const ok = response.status === expect;
  results.push({ step, name, ok, status: response.status });
  if (!ok) throw new Error(`${step} / ${name}: expected ${expect}, got ${response.status} ${data?.type?.split('/').pop() ?? ''}`);
  return { data, etag: response.headers.get('etag') ?? '"1"' };
}

const key = () => ({ 'Idempotency-Key': randomUUID() });
const today = new Date().toISOString().slice(0, 10);

async function main() {
  step = '1 pre-registration';
  await call('the patient submits the public form', 'POST', '/portal/pre-registrations', { as: 'public', body: example('POST', '/portal/pre-registrations'), expect: 204 });
  await call('a failed bot check is refused', 'POST', '/portal/pre-registrations', { as: 'public', body: example('POST', '/portal/pre-registrations'), expect: 422, prefer: 422 });

  step = '2 front desk creates the patient';
  const queue = (await call('the queue', 'GET', '/pre-registrations', { expect: 200 })).data.items;
  const preId = queue[0].id;
  await call('one request', 'GET', `/pre-registrations/${preId}`, { expect: 200 });
  await call('accept: a possible duplicate first', 'POST', `/pre-registrations/${preId}/accept`, { body: {}, headers: key(), expect: 409, prefer: 409 });
  const accepted = await call('accept: creates the patient (MRN)', 'POST', `/pre-registrations/${preId}/accept`, { body: { duplicateCheck: 'override', duplicateOverrideReason: 'Different person, same name.' }, headers: key(), expect: 200 });
  const patientId = accepted.data.patientId;
  await call('find the patient', 'POST', '/patients/search', { body: example('POST', '/patients/search'), expect: 200 });
  await call('read the patient', 'GET', `/patients/${patientId}`, { expect: 200 });

  step = '3 insurance and eligibility';
  await call('add insurance', 'POST', `/patients/${patientId}/coverages`, { body: example('POST', '/patients/{patientId}/coverages'), headers: key(), expect: 201 });
  const run = await call('run eligibility (simulated payer)', 'POST', '/eligibility-checks', { body: example('POST', '/eligibility-checks'), headers: key(), expect: 202 });
  await call('read the operation', 'GET', `/operations/${run.data.id}`, { expect: 200 });

  step = '4 booking';
  const facilities = (await call('bookable facilities', 'GET', '/booking/facilities', { expect: 200 })).data.items;
  const facilityId = facilities[0].id;
  const types = (await call('appointment types', 'GET', '/booking/appointment-types', { expect: 200 })).data.items;
  await call('providers', 'GET', `/booking/providers?facilityId=${facilityId}`, { expect: 200 });
  const slots = (await call('free times', 'GET', `/slots?facilityId=${facilityId}&date=${today}&appointmentTypeId=${types[0].id}`, { expect: 200 })).data.items;
  const booking = { ...example('POST', '/appointments'), patientId, facilityId, appointmentTypeId: types[0].id, providerId: slots[0].providerId, startAt: slots[0].startAt };
  const appointmentId = (await call('book', 'POST', '/appointments', { body: booking, headers: key(), expect: 201 })).data.id;

  step = '5 portal invitation';
  await call('issue the invitation code', 'POST', `/patients/${patientId}/portal-invitations`, { body: { idChecked: true }, expect: 201 });
  await call('the portal account panel', 'GET', `/patients/${patientId}/portal-account`, { expect: 200 });

  step = '6 check-in and status board';
  const checkedIn = await call('check in', 'POST', `/appointments/${appointmentId}/check-in`, { body: { selfPay: false }, headers: key(), expect: 200 });
  const encounterId = checkedIn.data.encounterId;
  await call('status board', 'GET', `/status-board?facilityId=${facilityId}`, { expect: 200 });

  step = '7 rooming';
  await call('roomed', 'POST', `/appointments/${appointmentId}/status`, { body: { status: 'roomed' }, expect: 200 });
  await call('vitals', 'POST', `/encounters/${encounterId}/vitals`, { body: example('POST', '/encounters/{encounterId}/vitals'), headers: key(), expect: 201 });
  await call('allergies', 'POST', `/patients/${patientId}/allergies`, { body: example('POST', '/patients/{patientId}/allergies'), headers: key(), expect: 201 });
  await call('current medications', 'POST', `/patients/${patientId}/medications`, { body: example('POST', '/patients/{patientId}/medications'), headers: key(), expect: 201 });
  const appt = await call('read the appointment', 'GET', `/appointments/${appointmentId}`, { expect: 200 });
  await call('reason for visit', 'PATCH', `/appointments/${appointmentId}`, { body: { reasonForVisit: 'Blood pressure follow-up' }, headers: { 'If-Match': appt.etag }, expect: 200 });

  step = '8 consultation';
  const encounter = await call('the visit workspace', 'GET', `/encounters/${encounterId}`, { expect: 200 });
  await call('problem list', 'GET', `/patients/${patientId}/problems`, { expect: 200 });
  await call('code search (ICD-10-CM)', 'GET', '/codes?system=icd-10-cm&q=hypertension', { expect: 200 });
  await call('add a diagnosis', 'POST', `/encounters/${encounterId}/diagnoses`, { body: example('POST', '/encounters/{encounterId}/diagnoses'), headers: key(), expect: 201 });
  const templates = (await call('note templates (note-templates:read)', 'GET', '/note-templates', { expect: 200 })).data.items;
  const note = await call('start a templated note', 'POST', `/encounters/${encounterId}/notes`, { body: { ...example('POST', '/encounters/{encounterId}/notes'), templateId: templates[0].id }, headers: key(), expect: 201 });
  const edited = await call('write the note', 'PATCH', `/notes/${note.data.id}`, { body: example('PATCH', '/notes/{noteId}'), headers: { 'If-Match': note.etag }, expect: 200 });
  await call('sign the note', 'POST', `/notes/${note.data.id}/sign`, { body: example('POST', '/notes/{noteId}/sign'), headers: { 'If-Match': edited.etag }, expect: 200 });

  step = '9 prescription';
  await call('drug search (RxNorm prescribable)', 'GET', '/codes?system=rxnorm&q=amoxicillin', { expect: 200 });
  const draft = await call('start a prescription', 'POST', '/prescriptions', { body: { ...example('POST', '/prescriptions'), patientId, encounterId }, headers: key(), expect: 201 });
  const check = await call('safety check: an allergy alert', 'POST', `/prescriptions/${draft.data.id}/safety-check`, { expect: 200 });
  await call('signing before the override is refused', 'POST', `/prescriptions/${draft.data.id}/sign-and-send`, { headers: { ...key(), 'If-Match': draft.etag }, expect: 422, prefer: 422 });
  await call('override with a reason', 'POST', `/alerts/${check.data.alerts[0].id}/override`, { body: example('POST', '/alerts/{alertId}/override'), expect: 200 });
  await call('sign and send to the (simulated) pharmacy', 'POST', `/prescriptions/${draft.data.id}/sign-and-send`, { headers: { ...key(), 'If-Match': draft.etag }, expect: 200 });
  await call('the medication list', 'GET', `/patients/${patientId}/medications`, { expect: 200 });

  step = '10 follow-up request';
  await call('ask for a follow-up in 3 months', 'PUT', `/encounters/${encounterId}/follow-up`, { body: example('PUT', '/encounters/{encounterId}/follow-up'), headers: { 'If-Match': encounter.etag }, expect: 200 });

  step = '11 check-out';
  await call('the appointment shows the follow-up', 'GET', `/appointments/${appointmentId}`, { expect: 200 });
  await call('copay', 'POST', `/patients/${patientId}/payments`, { body: example('POST', '/patients/{patientId}/payments'), headers: key(), expect: 201 });
  await call('checked out', 'POST', `/appointments/${appointmentId}/status`, { body: { status: 'checked-out' }, expect: 200 });
  const avs = await call('after-visit summary', 'POST', `/encounters/${encounterId}/after-visit-summary`, { body: example('POST', '/encounters/{encounterId}/after-visit-summary'), headers: key(), expect: 202 });
  await call('its operation', 'GET', `/operations/${avs.data.id}`, { expect: 200 });
  await call('book the revisit (marks the follow-up booked)', 'POST', '/appointments', { body: { ...booking, followUpOfEncounterId: encounterId }, headers: key(), expect: 201 });
  await call('close the visit', 'POST', `/encounters/${encounterId}/close`, { body: example('POST', '/encounters/{encounterId}/close'), expect: 200 });

  step = '12 patient portal';
  await call('sign in (to the patient realm)', 'GET', '/portal/auth/login', { as: 'public', expect: 302 });
  await call('the session', 'GET', '/portal/auth/session', { as: 'patient', expect: 200 });
  await call('the revisit', 'GET', '/portal/me/appointments', { as: 'patient', expect: 200 });
  const summaries = (await call('visit summaries', 'GET', '/portal/me/visit-summaries', { as: 'patient', expect: 200 })).data.items;
  const available = summaries.find((v) => v.releaseStatus === 'available');
  await call('download the visit summary', 'GET', `/portal/me/visit-summaries/${available.id}/download-url`, { as: 'patient', expect: 200 });
  await call('the prescription', 'GET', '/portal/me/medications', { as: 'patient', expect: 200 });
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    let last = '';
    for (const r of results) {
      if (r.step !== last) console.log(`— ${(last = r.step)}`);
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${r.name}`);
    }
    const steps = new Set(results.filter((r) => r.ok).map((r) => r.step)).size;
    console.log(`Demo story (${BASE_URL}): ${results.filter((r) => r.ok).length} of ${results.length} calls passed, across ${steps} of 12 steps.`);
  });
