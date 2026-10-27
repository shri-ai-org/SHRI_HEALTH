// The prescriptions flow (D97, D99; demo steps 7 and 9, contracts/docs/IMPL_BATCH1_PLAN.md §8.2 B): rooming records the
// current medications; the clinician searches RxNorm, drafts a prescription, runs the safety check (fixed rules, never
// AI), overrides a high alert with a reason, and signs and sends it through the outbox to the simulated pharmacy.
//
//   npm run mock                            (in another terminal; port 4010)
//   node tests/flows/prescriptions.mjs
//   BASE_URL=http://127.0.0.1:4020 node tests/flows/prescriptions.mjs
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

async function main() {
  const draftBody = example('POST', '/prescriptions');
  const { patientId } = draftBody;

  step = '7 rooming: current medications';
  await call('the medication list', 'GET', `/patients/${patientId}/medications`, { expect: 200 });
  await call('record a medication the patient takes', 'POST', `/patients/${patientId}/medications`, { body: example('POST', '/patients/{patientId}/medications'), headers: key(), expect: 201 });
  await call('a role without medications:create', 'POST', `/patients/${patientId}/medications`, { body: example('POST', '/patients/{patientId}/medications'), headers: key(), expect: 403, prefer: 403 });

  step = '9 the prescription';
  const found = (await call('drug search over RxNorm', 'GET', '/codes?system=rxnorm&q=amoxicillin', { expect: 200, answer: 'rxnorm' })).data.items;
  const drug = found.find((c) => c.system.endsWith('/rxnorm') && c.code === draftBody.medication.codings[0].code);
  if (!drug) throw new Error('the search must return the drug the draft uses');
  if (!drug.drug?.ingredients?.every((i) => i.rxcui && i.name) || !drug.drug.doseForm || !drug.drug.strength) throw new Error('an RxNorm result must carry its drug details');

  const draft = await call('start a draft', 'POST', '/prescriptions', { body: draftBody, headers: key(), expect: 201 });
  const rxId = draft.data.id;
  const read = await call('read the draft', 'GET', `/prescriptions/${rxId}`, { expect: 200, answer: 'draft' });
  await call('a stale If-Match is refused', 'PATCH', `/prescriptions/${rxId}`, { body: example('PATCH', '/prescriptions/{prescriptionId}'), headers: { 'If-Match': '"0"' }, expect: 412, prefer: 412 });
  await call('change the dose', 'PATCH', `/prescriptions/${rxId}`, { body: example('PATCH', '/prescriptions/{prescriptionId}'), headers: { 'If-Match': read.etag }, expect: 200 });

  const check = (await call('the safety check: an allergy alert', 'POST', `/prescriptions/${rxId}/safety-check`, { expect: 200, answer: 'allergy' })).data;
  const alert = check.alerts.find((a) => a.kind === 'allergy');
  if (alert?.severity !== 'high' || !alert.overrideRequired) throw new Error('a high allergy alert must need an override');
  const duplicate = (await call('the safety check: a duplicate medication', 'POST', `/prescriptions/${rxId}/safety-check`, { expect: 200, answer: 'duplicate' })).data;
  if (!duplicate.alerts.some((a) => a.kind === 'duplicate-medication')) throw new Error('the duplicate example must carry a duplicate-medication alert');

  const signHeaders = () => ({ 'If-Match': read.etag, ...key() });
  await call('signing before the override is refused', 'POST', `/prescriptions/${rxId}/sign-and-send`, { headers: signHeaders(), expect: 422, prefer: 422 });
  await call('a role without alerts:override', 'POST', `/alerts/${alert.id}/override`, { body: example('POST', '/alerts/{alertId}/override'), expect: 403, prefer: 403 });
  await call('override the alert with a reason', 'POST', `/alerts/${alert.id}/override`, { body: example('POST', '/alerts/{alertId}/override'), expect: 200 });

  const signed = (await call('sign and send (through the outbox)', 'POST', `/prescriptions/${rxId}/sign-and-send`, { headers: signHeaders(), expect: 200 })).data;
  if (signed.transmission?.status !== 'queued') throw new Error('a sent prescription starts as queued in the outbox');
  await call('its transmission status', 'GET', `/prescriptions/${rxId}`, { expect: 200, answer: 'signed' });
  await call('a signed prescription is locked', 'PATCH', `/prescriptions/${rxId}`, { body: example('PATCH', '/prescriptions/{prescriptionId}'), headers: { 'If-Match': read.etag }, expect: 409, prefer: 409 });
  await call('and is never entered-in-error (it is cancelled instead)', 'POST', `/prescriptions/${rxId}/entered-in-error`, { body: example('POST', '/prescriptions/{prescriptionId}/entered-in-error'), expect: 409, prefer: 409 });
  await call('the medication list now has it', 'GET', `/patients/${patientId}/medications`, { expect: 200 });

  step = 'a wrong draft';
  const wrong = (await call('another draft', 'POST', '/prescriptions', { body: draftBody, headers: key(), expect: 201 })).data;
  await call('marked entered-in-error, with a reason', 'POST', `/prescriptions/${wrong.id}/entered-in-error`, { body: example('POST', '/prescriptions/{prescriptionId}/entered-in-error'), expect: 200 });
  await call('without a session', 'POST', '/prescriptions', { as: 'none', body: draftBody, expect: 401 });
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
    console.log(`Prescriptions (${BASE_URL}): ${results.filter((r) => r.ok).length} of ${results.length} calls passed.`);
  });
