// The check-out flow (D98, D100; demo steps 10–11, contracts/docs/IMPL_BATCH1_PLAN.md §8.2 C): the clinician asks for
// a follow-up in the visit; at check-out the front desk sees it, takes the copay, produces the after-visit summary, books
// the revisit from it (or records that the patient declined), and checks the patient out.
//
//   npm run mock                          (in another terminal; port 4010)
//   node tests/flows/check-out.mjs
//   BASE_URL=http://127.0.0.1:4020 node tests/flows/check-out.mjs
//
// Request bodies are the contract's own request examples, so the flow always sends what the contract accepts; IDs
// come from the previous answers. `Prefer: code=…` asks the mock for the documented refusals and `Prefer: example=…`
// for a named answer. Calls use a mock staff session. Synthetic data only.
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
  none: {},
};
const results = [];
let step = 'setup';

/** A request example the contract gives for an operation (the first, or the one named). */
function example(method, path, name) {
  const content = contract.paths[path]?.[method.toLowerCase()]?.requestBody?.content ?? {};
  const examples = Object.values(content)[0]?.examples ?? {};
  const chosen = name ? examples[name] : Object.values(examples)[0];
  if (!chosen) throw new Error(`no request example ${name ?? ''} for ${method} ${path}`);
  return structuredClone(chosen.value);
}

async function call(name, method, path, { as = 'staff', body, expect, prefer, answer, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { Accept: 'application/json, application/problem+json', ...SESSIONS[as], ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const preferences = [prefer && `code=${prefer}`, answer && `example=${answer}`].filter(Boolean);
  if (preferences.length) init.headers.Prefer = preferences.join(', ');
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  const ok = response.status === expect;
  results.push({ step, name, ok, status: response.status });
  if (!ok) throw new Error(`${step} / ${name}: expected ${expect}, got ${response.status} ${data?.type?.split('/').pop() ?? ''}`);
  return { data, etag: response.headers.get('etag') ?? '"1"' };
}

const key = () => ({ 'Idempotency-Key': randomUUID() });
const FACILITY = '8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e';
const BOARD = `/status-board?facilityId=${FACILITY}&date=2026-11-03`;

async function main() {
  const board = (await call('the staff board, to find the visit', 'GET', `${BOARD}&view=staff`, { expect: 200, answer: 'staff' })).data;
  const { appointmentId, encounterId } = board.items[0];
  const patientId = board.items[0].patient.id;

  step = '10 the follow-up request';
  const encounter = await call('the clinician opens the visit', 'GET', `/encounters/${encounterId}`, { expect: 200 });
  const followUp = example('PUT', '/encounters/{encounterId}/follow-up');
  await call('a stale If-Match (another tab changed the visit)', 'PUT', `/encounters/${encounterId}/follow-up`, { body: followUp, headers: { 'If-Match': '"0"' }, expect: 412, prefer: 412 });
  await call('a role without encounters:update', 'PUT', `/encounters/${encounterId}/follow-up`, { body: followUp, headers: { 'If-Match': encounter.etag }, expect: 403, prefer: 403 });
  const asked = await call('ask for a revisit in 3 months', 'PUT', `/encounters/${encounterId}/follow-up`, { body: followUp, headers: { 'If-Match': encounter.etag }, expect: 200 });
  if (asked.data.status !== 'open') throw new Error('a new follow-up request must be open');

  step = '11 check-out';
  const atDesk = (await call('the front desk reads the appointment', 'GET', `/appointments/${appointmentId}`, { expect: 200, answer: 'at-check-out' })).data;
  if (atDesk.followUp?.status !== 'open' || atDesk.followUp.encounterId !== encounterId) throw new Error('the appointment must carry the open follow-up');
  const staff = (await call('the staff board shows the follow-up', 'GET', `${BOARD}&view=staff`, { expect: 200, answer: 'staff' })).data;
  if (!staff.items[0].followUp) throw new Error('the staff board must carry the follow-up');
  const shared = (await call('the shared board never does (D47)', 'GET', `${BOARD}&view=shared`, { expect: 200, answer: 'shared' })).data;
  if (shared.items.some((item) => 'followUp' in item)) throw new Error('the shared board must not carry the follow-up');

  await call("the copay due, from the appointment's eligibility checks", 'GET', `/appointments/${appointmentId}/eligibility-checks`, { expect: 200 });
  const session = await call('start the card payment (hosted fields)', 'POST', '/payments/card-session', { body: example('POST', '/payments/card-session'), headers: key(), expect: 201 });
  const payment = example('POST', '/patients/{patientId}/payments', 'copay-card');
  payment.cardSessionId = session.data.id;
  await call('a card session for another amount is refused', 'POST', `/patients/${patientId}/payments`, { body: payment, headers: key(), expect: 422, prefer: 422 });
  await call('record the copay, with its receipt', 'POST', `/patients/${patientId}/payments`, { body: payment, headers: key(), expect: 201 });

  const summary = await call('the after-visit summary', 'POST', `/encounters/${encounterId}/after-visit-summary`, { body: example('POST', '/encounters/{encounterId}/after-visit-summary'), headers: key(), expect: 202 });
  await call('its operation', 'GET', `/operations/${summary.data.id}`, { expect: 200 });

  const revisit = example('POST', '/appointments', 'revisit');
  if (revisit.followUpOfEncounterId !== encounterId) throw new Error('the revisit example must book this visit\'s follow-up');
  await call('a follow-up that is not open is refused', 'POST', '/appointments', { body: revisit, headers: key(), expect: 422, prefer: 422 });
  await call('book the revisit from the follow-up', 'POST', '/appointments', { body: revisit, headers: key(), expect: 201 });
  await call('declining an already booked follow-up is refused', 'POST', `/encounters/${encounterId}/follow-up/decline`, { body: example('POST', '/encounters/{encounterId}/follow-up/decline'), expect: 409, prefer: 409 });
  await call('or, had the patient said no: decline with a reason', 'POST', `/encounters/${encounterId}/follow-up/decline`, { body: example('POST', '/encounters/{encounterId}/follow-up/decline'), expect: 200 });

  await call('check the patient out', 'POST', `/appointments/${appointmentId}/status`, { body: example('POST', '/appointments/{appointmentId}/status', 'checked-out'), expect: 200 });
  await call('without a session', 'POST', `/appointments/${appointmentId}/status`, { as: 'none', body: { status: 'checked-out' }, expect: 401 });
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
    console.log(`Check-out (${BASE_URL}): ${results.filter((r) => r.ok).length} of ${results.length} calls passed.`);
  });
