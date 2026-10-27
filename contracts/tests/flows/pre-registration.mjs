// The pre-registration flow (D96; demo step 1, contracts/docs/IMPL_BATCH1_PLAN.md §8.2 A): a new patient submits
// the public form, then the front desk works its queue and accepts or rejects each request.
//
//   npm run mock                                (in another terminal; port 4010)
//   node tests/flows/pre-registration.mjs
//   BASE_URL=http://127.0.0.1:4020 node tests/flows/pre-registration.mjs
//
// Request bodies are the contract's own request examples, so the flow always sends what the contract accepts; IDs
// come from the previous answers. `Prefer: code=…` asks the mock for the documented refusals. Staff calls use a mock
// staff session; the public form sends no cookie at all. Synthetic data only.
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
let step = '';

/** A request example the contract gives for an operation (the first, or the one named). */
function example(method, path, name) {
  const content = contract.paths[path]?.[method.toLowerCase()]?.requestBody?.content ?? {};
  const examples = Object.values(content)[0]?.examples ?? {};
  const chosen = name ? examples[name] : Object.values(examples)[0];
  if (!chosen) throw new Error(`no request example ${name ?? ''} for ${method} ${path}`);
  return structuredClone(chosen.value);
}

async function call(name, method, path, { as = 'staff', body, expect, prefer, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { Accept: 'application/json, application/problem+json', ...SESSIONS[as], ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  if (prefer) init.headers.Prefer = `code=${prefer}`;
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  const ok = response.status === expect;
  results.push({ step, name, ok, status: response.status });
  if (!ok) throw new Error(`${step} / ${name}: expected ${expect}, got ${response.status} ${data?.type?.split('/').pop() ?? ''}`);
  return { data, text };
}

const key = () => ({ 'Idempotency-Key': randomUUID() });

// The practice's own link carries its opaque code; the clinic is resolved from it on the server (D96).
const FORM = '/portal/practices/{practiceLinkId}/pre-registrations';
const LINK = FORM.replace('{practiceLinkId}', 'TEST-practice-link-0001');

async function main() {
  step = 'the public form';
  const form = example('POST', FORM);
  if ('preferredFacilityId' in form.details) throw new Error('the form has no facility (D96)');
  if (!form.details.phones?.length && !form.details.email) throw new Error('the form example needs a phone or an email');
  const submit = { as: 'none', body: form };
  const received = await call('a new patient submits it', 'POST', LINK, { ...submit, headers: key(), expect: 204 });
  if (received.text) throw new Error('the public form must answer with no body');
  await call('a failed bot check is refused', 'POST', LINK, { ...submit, headers: key(), expect: 422, prefer: 422 });
  await call('an unknown practice link', 'POST', LINK, { ...submit, headers: key(), expect: 404, prefer: 404 });
  await call('a wrong Origin is refused', 'POST', LINK, { ...submit, headers: key(), expect: 403, prefer: 403 });
  await call('too many submissions are rate-limited', 'POST', LINK, { ...submit, headers: key(), expect: 429, prefer: 429 });

  step = "the front desk's queue";
  await call('without a session', 'GET', '/pre-registrations', { as: 'none', expect: 401 });
  await call('a role without pre-registrations:read', 'GET', '/pre-registrations', { expect: 403, prefer: 403 });
  const queue = (await call('pending requests', 'GET', '/pre-registrations?status=pending', { expect: 200 })).data.items;
  if (!queue.length) throw new Error('the queue example has no pending request');
  const preId = queue[0].id;
  const one = (await call('one request', 'GET', `/pre-registrations/${preId}`, { expect: 200 })).data;
  if (!one.details.insurance) throw new Error('the queue read must return the insurance note');

  step = 'accept';
  const create = example('POST', '/pre-registrations/{preRegistrationId}/accept', 'create');
  if (create.identityVerified !== true || !create.idDocumentType) throw new Error('accept must carry the ID check');
  await call('a possible duplicate first', 'POST', `/pre-registrations/${preId}/accept`, { body: create, headers: key(), expect: 409, prefer: 409 });
  const accepted = await call('create the patient (MRN)', 'POST', `/pre-registrations/${preId}/accept`, { body: create, headers: key(), expect: 200 });
  if (accepted.data.status !== 'accepted' || !accepted.data.patientId) throw new Error('an accepted request must link its patient');
  if (!accepted.data.identityCheck?.verifiedBy) throw new Error('an accepted request must record its ID check');
  const link = example('POST', '/pre-registrations/{preRegistrationId}/accept', 'link');
  await call('or link an existing patient', 'POST', `/pre-registrations/${preId}/accept`, { body: link, headers: key(), expect: 200 });
  await call('a request already decided', 'POST', `/pre-registrations/${preId}/accept`, { body: create, headers: key(), expect: 409, prefer: 409 });

  step = 'reject';
  await call('as spam', 'POST', `/pre-registrations/${preId}/reject`, { body: example('POST', '/pre-registrations/{preRegistrationId}/reject', 'spam'), expect: 200 });
  await call('"other" with its reason', 'POST', `/pre-registrations/${preId}/reject`, { body: example('POST', '/pre-registrations/{preRegistrationId}/reject', 'other'), expect: 200 });
  await call('"other" without a reason is refused', 'POST', `/pre-registrations/${preId}/reject`, { body: { reasonCode: 'other' }, expect: 422, prefer: 422 });
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
    console.log(`Pre-registration (${BASE_URL}): ${results.filter((r) => r.ok).length} of ${results.length} calls passed.`);
  });
