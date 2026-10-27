// Note templates for clinicians (D73, T42; demo step 8) and the portal's medication list (plan §8.2 E; demo step 12),
// against the sample-data server: a clinician picks a template with `note-templates:read`, and the patient sees the new
// prescription with its transmission status in the portal.
//
//   npm run mock                                              (in another terminal; port 4010)
//   node tests/flows/templates-and-portal-medications.mjs
//   BASE_URL=http://127.0.0.1:4020 node tests/flows/templates-and-portal-medications.mjs
//
// `Prefer: code=…` asks the mock for the documented refusals. Staff calls use a mock staff session, portal calls a
// mock patient session (MOCK_GUIDE §5d). Synthetic data only.
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');
const SESSIONS = {
  staff: { Cookie: '__Host-shri_session=mock', 'X-CSRF-Token': 'mock' },
  patient: { Cookie: '__Host-shri_portal=mock', 'X-CSRF-Token': 'mock' },
  none: {},
};
const results = [];
let step = '';

async function call(name, method, path, { as = 'staff', expect, prefer } = {}) {
  const init = { method, redirect: 'manual', headers: { Accept: 'application/json, application/problem+json', ...SESSIONS[as] } };
  if (prefer) init.headers.Prefer = `code=${prefer}`;
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  const ok = response.status === expect;
  results.push({ step, name, ok, status: response.status });
  if (!ok) throw new Error(`${step} / ${name}: expected ${expect}, got ${response.status} ${data?.type?.split('/').pop() ?? ''}`);
  return { data };
}

async function main() {
  step = '8 a clinician picks a note template';
  const templates = (await call('the practice\'s templates', 'GET', '/note-templates', { expect: 200 })).data.items;
  await call('one template', 'GET', `/note-templates/${templates[0].id}`, { expect: 200 });
  await call('a role without note-templates:read (FD)', 'GET', '/note-templates', { expect: 403, prefer: 403 });

  step = '12 the patient sees the prescription';
  const meds = (await call('my medications', 'GET', '/portal/me/medications', { as: 'patient', expect: 200 })).data.items;
  const prescription = meds.find((m) => m.source === 'prescription');
  if (!prescription?.transmissionStatus) throw new Error('a prescription on the portal list must carry its transmission status');
  if (meds.some((m) => 'patientId' in m)) throw new Error('portal items never name the patient (D84)');
  await call('the staff cookie alone is refused', 'GET', '/portal/me/medications', { as: 'staff', expect: 401 });
  await call('without a session', 'GET', '/portal/me/medications', { as: 'none', expect: 401 });
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
    console.log(`Templates and portal medications (${BASE_URL}): ${results.filter((r) => r.ok).length} of ${results.length} calls passed.`);
  });
