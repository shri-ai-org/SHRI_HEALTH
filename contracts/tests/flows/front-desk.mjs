// The front-desk flow (contracts/docs/IMPL_BATCH1_PLAN.md §4.4): search, register, the duplicate warning,
// edit, insurance, booking, check-in, the status board, undo check-in, reschedule, cancel and the
// appointment's eligibility checks, in the order the front desk works.
//
//   node tests/flows/front-desk.mjs                      against the mock (npm run mock, port 4010)
//   BASE_URL=http://127.0.0.1:4020 node tests/flows/front-desk.mjs
//   TARGET=api BASE_URL=http://127.0.0.1:8000/api/v1 node tests/flows/front-desk.mjs
//
// TARGET=mock (default) signs in with a mock session cookie and checks each status code; Prism answers
// with the contract's examples, and `Prefer: code=…` asks it for the documented refusals.
// TARGET=api signs in with the development login (X-Dev-User: fd; development and test only) and also
// checks the state each step leaves behind. It needs a database seeded with synthetic practice data.
// Synthetic data only, never a real patient.
import { randomUUID } from 'node:crypto';

const TARGET = process.env.TARGET ?? 'mock';
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');
const api = TARGET === 'api';
const auth = api
  ? { 'X-Dev-User': process.env.DEV_USER ?? 'fd' }
  : { Cookie: '__Host-shri_session=mock', 'X-CSRF-Token': 'mock' };

const results = [];

async function call(name, method, path, { body, headers = {}, expect, prefer } = {}) {
  const init = { method, headers: { Accept: 'application/json, application/problem+json', ...auth, ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  if (prefer && !api) init.headers.Prefer = `code=${prefer}`;
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  const ok = response.status === expect;
  results.push({ name, ok, status: response.status, expect });
  if (!ok) {
    const problem = data && data.type ? ` ${data.type.split('/').pop()}` : '';
    throw new Error(`${name}: expected ${expect}, got ${response.status}${problem}`);
  }
  return { data, etag: response.headers.get('etag') };
}

function check(name, condition) {
  if (!api) return; // the mock returns fixed examples, so state checks only mean something on the API
  results.push({ name, ok: Boolean(condition), status: '-', expect: 'state' });
  if (!condition) throw new Error(`${name}: unexpected state`);
}

const today = new Date().toISOString().slice(0, 10);
const person = { name: { given: ['Ramona980'], family: `Kuhlman${Math.floor(Math.random() * 90) + 10}` }, birthDate: '1984-07-19' };

async function main() {
  await call('search patients', 'POST', '/patients/search', {
    body: { criteria: { family: person.name.family, birthDate: person.birthDate }, limit: 25 }, expect: 200,
  });
  const registered = await call('register a patient', 'POST', '/patients', {
    body: { ...person, gender: 'female', phones: [{ number: '+12175550123', use: 'mobile' }] },
    headers: { 'Idempotency-Key': randomUUID() }, expect: 201,
  });
  const patientId = registered.data.id;
  await call('register them again: possible duplicate', 'POST', '/patients', {
    body: { ...person, gender: 'female' }, headers: { 'Idempotency-Key': randomUUID() },
    expect: 409, prefer: 409,
  });
  const read = await call('read the patient', 'GET', `/patients/${patientId}`, { expect: 200 });
  check('the read has an ETag', read.etag);
  await call('edit the patient (If-Match)', 'PATCH', `/patients/${patientId}`, {
    body: { preferredName: 'Mona' }, headers: { 'If-Match': read.etag ?? '"1"' }, expect: 200,
  });
  await call('edit with a stale ETag', 'PATCH', `/patients/${patientId}`, {
    body: { preferredName: 'Ramona' }, headers: { 'If-Match': '"0"' }, expect: 412, prefer: 412,
  });

  const payers = api ? (await call('payer directory', 'GET', '/payers?limit=5', { expect: 200 })).data.items : [];
  await call('add insurance', 'POST', `/patients/${patientId}/coverages`, {
    body: { order: 1, payerId: payers[0]?.id ?? randomUUID(), memberId: 'TEST-MEMBER-001', relationshipToSubscriber: 'self' },
    headers: { 'Idempotency-Key': randomUUID() }, expect: 201,
  });

  const facilities = (await call('bookable facilities', 'GET', '/booking/facilities', { expect: 200 })).data.items;
  const facilityId = facilities[0].id;
  const types = (await call('appointment types', 'GET', '/booking/appointment-types', { expect: 200 })).data.items;
  await call('providers', 'GET', `/booking/providers?facilityId=${facilityId}`, { expect: 200 });
  const slots = (await call('free times', 'GET', `/slots?facilityId=${facilityId}&date=${today}&appointmentTypeId=${types[0].id}`, { expect: 200 })).data.items;
  const slot = slots[0];

  const booked = await call('book', 'POST', '/appointments', {
    body: { patientId, providerId: slot.providerId, facilityId, appointmentTypeId: types[0].id, startAt: slot.startAt, sameDayAddOn: true },
    headers: { 'Idempotency-Key': randomUUID() }, expect: 201,
  });
  const appointmentId = booked.data.id;
  check('booked', booked.data.status === 'booked');
  await call('book the same time again', 'POST', '/appointments', {
    body: { patientId, providerId: slot.providerId, facilityId, appointmentTypeId: types[0].id, startAt: slot.startAt },
    headers: { 'Idempotency-Key': randomUUID() }, expect: 409, prefer: 409,
  });

  const checkInKey = randomUUID();
  const checkedIn = await call('check in', 'POST', `/appointments/${appointmentId}/check-in`, {
    body: { selfPay: false }, headers: { 'Idempotency-Key': checkInKey }, expect: 200,
  });
  check('checked in, with an encounter', checkedIn.data.appointment.status === 'checked-in' && checkedIn.data.encounterId);
  const replay = await call('check in again with the same key', 'POST', `/appointments/${appointmentId}/check-in`, {
    body: { selfPay: false }, headers: { 'Idempotency-Key': checkInKey }, expect: 200,
  });
  check('the replay is the same result', replay.data.encounterId === checkedIn.data.encounterId);
  await call('status board', 'GET', `/status-board?facilityId=${facilityId}`, { expect: 200 });
  await call('eligibility checks for the appointment', 'GET', `/appointments/${appointmentId}/eligibility-checks`, { expect: 200 });

  const undone = await call('undo check-in', 'POST', `/appointments/${appointmentId}/undo-check-in`, {
    body: { reason: 'Checked in the wrong patient.' }, expect: 200,
  });
  check('booked again', undone.data.status === 'booked');
  const later = slots[1] ?? slot;
  const moved = await call('reschedule', 'POST', `/appointments/${appointmentId}/reschedule`, {
    body: { startAt: later.startAt, reasonCode: 'pat', reasonText: 'Patient asked for a later time.' },
    headers: { 'Idempotency-Key': randomUUID() }, expect: 201,
  });
  check('the new appointment points back', moved.data.rescheduledFromId === appointmentId);
  await call('cancel', 'POST', `/appointments/${moved.data.id}/cancel`, {
    body: { reasonCode: 'pat', reasonText: 'Patient cancelled by phone.' }, expect: 200,
  });
  await call('cancel again: not allowed', 'POST', `/appointments/${moved.data.id}/cancel`, {
    body: { reasonCode: 'pat' }, expect: 409, prefer: 409,
  });
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(5)} ${r.name}`);
    console.log(`Front-desk flow (${TARGET}, ${BASE_URL}): ${results.filter((r) => r.ok).length} of ${results.length} steps passed.`);
  });
