# Mock server guide (for screen work)

Status: Stage 4 batch 1 · 2026-10-23 · Author: Vimal (drafted with Claude Code) · For: Minalini, and anyone wiring screens before the real API exists

The mock server answers every endpoint in the contract with the contract's own examples, so screens can be built and tested now. It runs [Prism](https://github.com/stoplightio/prism) on the bundled contract (`openapi/dist/shri-health.bundled.yaml`). All data in it is synthetic.

**Batch 1 endpoints:** patients and insurance, scheduling and check-in, eligibility, practice setup, and the payer directory. Other areas arrive in later batches; until then the mock answers `404` for their paths.

## 1. Start it

You need **Node.js 24** (the exact version is in `contracts/.nvmrc`; with nvm: `nvm use`).

```bash
cd contracts
npm ci --ignore-scripts
npm run mock
```

- It listens on `http://127.0.0.1:4010`. Set `PORT` to use another port: `PORT=4020 npm run mock`.
- `npm run mock` bundles the contract first, so you always mock the files on your branch. Restart it after pulling contract changes.
- If npm asks to approve the `@scarf/scarf` install script, say no; `--ignore-scripts` skips it anyway.

## 2. Base URL: mock versus real API

| | Mock | Real API |
|---|---|---|
| Versioned endpoints | `http://127.0.0.1:4010/patients/search` | `https://<host>/api/v1/patients/search` |
| `/health` and `/hooks/*` | `http://127.0.0.1:4010/health` | `https://<host>/health` (outside `/api/v1`) |

Prism serves paths **without** the `/api/v1` prefix. Keep the prefix in one setting of the generated client, for example `VITE_API_BASE_URL=http://127.0.0.1:4010` for the mock and `/api/v1` for the real API, so no screen code changes when you switch.

## 3. Sign-in and headers in the mock

There is no real login. Prism only checks that the security values are **present**:

| What | Send in the mock | In the real API |
|---|---|---|
| Session cookie | `Cookie: __Host-shri_session=mock` (any value) | Set by `/auth/callback`; the browser sends it |
| CSRF header, on POST, PUT and PATCH | `X-CSRF-Token: mock` (any value) | The `csrfToken` from `GET /auth/session` |
| `Idempotency-Key` | A UUID where the operation requires it (check-in, eligibility checks) | Same |
| `If-Match`, on PATCH and PUT | Any quoted value, e.g. `"v1"` | The `ETag` from the last read |

Without the cookie you get `401`; without a required header, `422`.

## 4. Choosing a response

Prism returns the first example of the success response unless you ask for another with the `Prefer` header:

| You want | Header |
|---|---|
| A named example | `Prefer: example=pending` |
| An error status | `Prefer: code=409` |
| A specific error example | `Prefer: code=409, example=booking-conflict` |
| Random data generated from the schemas | `Prefer: dynamic=true` (not checked as synthetic: never use it for screenshots or demos) |

Example names are listed per operation in the contract (for example `GET /eligibility-checks/{eligibilityCheckId}` has `active`, `pending` and `error`). The shared error examples are named after their code: `validation-failed`, `booking-conflict`, `patient-merged`, `break-glass-required`, `possible-duplicate`, `precondition-failed` and the rest.

## 5. A front-desk flow

These calls work against the mock as written: session → booking lists → search → register → add coverage → book → check in → read the eligibility result → reschedule → undo check-in → copay → pharmacy and summaries.

```bash
B=http://127.0.0.1:4010
H=(-H 'Cookie: __Host-shri_session=mock' -H 'X-CSRF-Token: mock' -H 'Content-Type: application/json')
P=7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d   # the example patient

curl -s $B/auth/session -H 'Cookie: __Host-shri_session=mock'                       # user, csrfToken, expiries (D52)
curl -s "$B/booking/providers?facilityId=8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e" -H 'Cookie: __Host-shri_session=mock'   # bookable providers (D49)
curl -s -X POST $B/patients/search "${H[@]}" -d '{"criteria":{"family":"Kuhlman72","birthDate":"1984-07-19"}}'
curl -s -X POST $B/patients "${H[@]}" -d '{"name":{"given":["Ramona980"],"family":"Kuhlman72"},"birthDate":"1984-07-19"}'
curl -s -X POST $B/patients/$P/coverages "${H[@]}" \
  -d '{"order":1,"payerId":"4b5c6d7e-8f9a-4b0c-8d1e-2f3a4b5c6d7e","memberId":"TEST-M0012345","relationshipToSubscriber":"self"}'
curl -s -X POST $B/appointments "${H[@]}" -d '{"patientId":"'$P'","providerId":"6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c",
  "facilityId":"8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e","appointmentTypeId":"0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a","startAt":"2026-11-03T15:00:00Z"}'
curl -s -X POST $B/appointments/1e2f3a4b-5c6d-4e7f-9a8b-9c0d1e2f3a4b/check-in "${H[@]}" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"selfPay":false}'   # a new UUID per user action
curl -s $B/eligibility-checks/3a4b5c6d-7e8f-4a9b-9c0d-1e2f3a4b5c6d -H 'Cookie: __Host-shri_session=mock' -H 'Prefer: example=active'
curl -s -X POST $B/appointments/1e2f3a4b-5c6d-4e7f-9a8b-9c0d1e2f3a4b/reschedule "${H[@]}" \
  -d '{"startAt":"2026-11-03T15:40:00Z","reasonCode":"pat"}'                       # D61: new appointment with rescheduledFromId
curl -s -X POST $B/appointments/1e2f3a4b-5c6d-4e7f-9a8b-9c0d1e2f3a4b/undo-check-in "${H[@]}" \
  -d '{"reason":"Checked in the wrong patient of the same name."}'                 # D55: back to booked
curl -s -X POST $B/patients/$P/payments "${H[@]}" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount":{"value":"25.00","currency":"USD"},"method":"cash","appointmentId":"1e2f3a4b-5c6d-4e7f-9a8b-9c0d1e2f3a4b"}'   # D58: receiptFileId
curl -s "$B/pharmacies?postalCode=62703" -H 'Cookie: __Host-shri_session=mock'       # D50
curl -s -X POST $B/patients/summaries "${H[@]}" -d '{"patientIds":["'$P'"]}'      # D54
```

## 5b. A clinical flow (batch 2)

Encounters, notes and history (D73): open a telephone encounter → read the workspace → record vitals in U.S. units (D69) → add and remove a diagnosis → start, autosave and sign a note → the co-signer returns it → addendum → co-sign → after-visit summary → add an allergy and a problem → timeline. `If-Match` values are placeholders: the real API compares them with the record's `ETag`.

```bash
B=http://127.0.0.1:4010
H=(-H 'Cookie: __Host-shri_session=mock' -H 'X-CSRF-Token: mock' -H 'Content-Type: application/json')
P=7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d   # the example patient
E=5d6e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f8a   # the example encounter
N=6e7f8a9b-0c1d-4e2f-9a3b-4c5d6e7f8a9b   # the example note
D=8a9b0c1d-2e3f-4a4b-9c5d-6e7f8a9b0c1d   # the example diagnosis

curl -s -X POST $B/encounters "${H[@]}" -d '{"patientId":"'$P'","unscheduledType":"telephone","facilityId":"8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e"}'
curl -s $B/encounters/$E -H 'Cookie: __Host-shri_session=mock'                       # workspace: diagnoses, vitals, note summaries
curl -s -X POST $B/encounters/$E/vitals "${H[@]}" \
  -d '{"entries":[{"type":"body-weight","value":{"value":182.4,"unit":"[lb_av]"}},{"type":"body-temperature","value":{"value":98.6,"unit":"[degF]"}}]}'   # D69
curl -s "$B/codes?system=icd-10-cm&q=hypertension" -H 'Cookie: __Host-shri_session=mock'   # code search (reference data)
curl -s -X POST $B/encounters/$E/diagnoses "${H[@]}" -d '{"code":{"system":"http://hl7.org/fhir/sid/icd-10-cm","code":"I10"}}'
curl -s -X POST $B/encounters/$E/diagnoses/$D/remove "${H[@]}" -d '{"reason":"Added to the wrong encounter."}'   # D24
curl -s -X POST $B/encounters/$E/notes "${H[@]}" -d '{"templateId":"1d2e3f4a-5b6c-4d7e-8f8a-9b0c1d2e3f4a"}'
curl -s -X PATCH $B/notes/$N -H 'Cookie: __Host-shri_session=mock' -H 'X-CSRF-Token: mock' -H 'Content-Type: application/merge-patch+json' -H 'If-Match: "3"' \
  -d '{"sections":[{"id":"3f4a5b6c-7d8e-4f9a-8b0c-1d2e3f4a5b6c","text":"Continue current medication; recheck in 4 weeks."}]}'   # autosave
curl -s -X POST $B/notes/$N/sign -H 'Cookie: __Host-shri_session=mock' -H 'X-CSRF-Token: mock' -H 'If-Match: "4"'
curl -s -X POST $B/notes/$N/cosign "${H[@]}" -H 'If-Match: "5"' -H 'Prefer: example=returned' \
  -d '{"decision":"return","comment":"Please document the home readings you reviewed."}'   # return to author
curl -s -X POST $B/notes/$N/addenda "${H[@]}" -H 'If-Match: "6"' -d '{"text":"Reviewed the home blood pressure log."}'
curl -s -X POST $B/notes/$N/cosign "${H[@]}" -H 'If-Match: "7"' -d '{"decision":"cosign"}'
curl -s -X POST $B/encounters/$E/after-visit-summary "${H[@]}" -d '{}'               # 202 and an operation
curl -s -X POST $B/patients/$P/allergies "${H[@]}" -d '{"code":{"codings":[{"system":"http://www.nlm.nih.gov/research/umls/rxnorm","code":"7980"}]},"criticality":"high"}'
curl -s -X POST $B/patients/$P/problems "${H[@]}" -d '{"code":{"codings":[{"system":"http://hl7.org/fhir/sid/icd-10-cm","code":"E11.9"}]},"onsetDate":"2019"}'
curl -s "$B/patients/$P/timeline?types=note&types=problem" -H 'Cookie: __Host-shri_session=mock'
```

## 5c. An inbox flow (batch 3)

Inbox, tasks and messages (D77): a medical assistant asks the front desk to move an appointment (a task for the front-desk role, D67) → the front desk takes it from the queue and completes it → a physician messages a nurse about a patient → the nurse replies, which hands it back → the physician reads the thread and completes it → completing a co-sign item by hand is refused → badge counts. Prism returns the first example unless you name one (`Prefer: example=message`); `If-Match` values are placeholders.

```bash
B=http://127.0.0.1:4010
H=(-H 'Cookie: __Host-shri_session=mock' -H 'X-CSRF-Token: mock' -H 'Content-Type: application/json')
F=5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c   # the example facility
P=7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d   # the example patient
T=0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d   # the example task
M=a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d   # the example message
K=b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e   # the example co-sign item

curl -s -X POST $B/messages "${H[@]}" -d '{"kind":"task","assignee":{"type":"role","id":"4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b"},"facilityId":"'$F'","title":"Please move this follow-up to next week","dueAt":"2026-11-05T22:00:00Z","patientId":"'$P'","subject":{"type":"appointment","id":"9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e"}}'   # D67
curl -s "$B/inbox?view=queue&itemType=task" -H 'Cookie: __Host-shri_session=mock'
curl -s -X PATCH $B/inbox/$T -H 'Cookie: __Host-shri_session=mock' -H 'X-CSRF-Token: mock' -H 'Content-Type: application/merge-patch+json' -H 'If-Match: "1"' \
  -d '{"assignee":{"type":"user","id":"2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"}}'   # take it from the queue
curl -s -X POST $B/inbox/$T/complete "${H[@]}" -d '{"comment":"Moved to Thursday 10:30."}'
curl -s -X POST $B/messages "${H[@]}" -H 'Prefer: example=message' \
  -d '{"kind":"message","assignee":{"type":"user","id":"3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a"},"facilityId":"'$F'","title":"Recheck blood pressure today","priority":"urgent","patientId":"'$P'"}'
curl -s -X POST $B/inbox/$M/replies "${H[@]}" -d '{"text":"Rechecked: 128/82 seated, left arm."}'   # hands it back
curl -s $B/inbox/$M -H 'Cookie: __Host-shri_session=mock' -H 'Prefer: example=message'   # the thread
curl -s -X POST $B/inbox/$M/complete "${H[@]}" -d '{}'
curl -s -X POST $B/inbox/$K/complete "${H[@]}" -H 'Prefer: code=422' -d '{}'   # a co-sign item is completed by co-signing (D77)
curl -s $B/inbox/summary -H 'Cookie: __Host-shri_session=mock'
```

## 5d. Patient portal (B8a)

The portal contract (`portal.yaml`, D89) is served by the same sample-data server, with no extra setup: `npm run mock` answers every `/portal/...` path, with synthetic examples in every response. The portal's staff side (`/patients/{patientId}/portal-account`, invitations, disable, enable, factor reset) is served there too.

**Start it** as in §1, on a branch that has `portal.yaml` (on `main` once #73 merges):

```bash
cd contracts
npm run mock          # or PORT=4020 npm run mock
```

Portal paths keep their `/portal` prefix and, like every path here, drop `/api/v1`: the mock's `http://127.0.0.1:4010/portal/me` is the real API's `/api/v1/portal/me`.

**Acting as a signed-in patient.** Portal operations take the **portal** session cookie, never the staff one:

| What | Send in the mock | In the real API |
|---|---|---|
| Patient session cookie | `Cookie: __Host-shri_portal=mock` (any value) | Set by `/portal/auth/callback` on the portal host (ADR-0013 §5) |
| CSRF header, on POST | `X-CSRF-Token: mock` | The `csrfToken` from `GET /portal/auth/session` |
| `Idempotency-Key` | A UUID on enrollment, booking, rescheduling and change requests | Same |

- **Refusals:** without the portal cookie you get `401`, including when you send only the staff cookie. Nothing in a request names the patient (D84): the mock's examples are one synthetic patient, and the real API takes the patient from the session.
- **Sign-in screens:** `GET /portal/auth/login` answers `302`.
- **Enrollment:** `POST /portal/enrollments` is public, so send no cookie. It answers `204`, and `Prefer: code=422, example=business-rule-violation` gives the refusal the screen turns into its one "We couldn't use that code" message (the shared example; on the real API `errors` names `/invitationCode`).
- **Choosing an example:** use the `Prefer` header (§4):

  | Operation | Examples |
  |---|---|
  | `GET /portal/me/appointments` | `upcoming` (default) and `past`; past visits carry `visitSummaryId` |
  | `GET /portal/me/visit-summaries/{visitSummaryId}` | `one` and `held` |
  | `GET /portal/me/visit-summaries` and `GET /portal/me/problems` | the list mixes an available item and a held one (D86, D90) |
  | Refusals | `Prefer: code=409` (a time just taken, or an appointment already checked in), `Prefer: code=422` (too late to cancel online) and the other documented ones |

```bash
B=http://127.0.0.1:4010
P=(-H 'Cookie: __Host-shri_portal=mock' -H 'X-CSRF-Token: mock' -H 'Content-Type: application/json')
curl -s $B/portal/auth/session "${P[@]}"
curl -s $B/portal/me "${P[@]}"
curl -s "$B/portal/me/appointments?when=past" "${P[@]}" -H 'Prefer: example=past'
curl -s -X POST $B/portal/me/change-requests "${P[@]}" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"changes":{"preferredLanguage":"es"}}'
```

**Against the real API later:** the patient realm and core's portal session aren't built yet (ADR-0013, T45). A development sign-in for the patient role, like the staff `X-Dev-User`, has been asked for, so the portal can be tested against the backend before the realm exists.

**Hidden behind feature switches until their contracts exist (all P1):** Pay bills (payments and the ledger), Video (telehealth) and Immunizations. Hide them, don't delete them. Messages, results, prescriptions, documents, forms and record exports come with B8b (D88, D89); until then they stay on the portal's own in-memory mock.
## 5e. Pre-registration (demo step 1, D96)

`tests/flows/pre-registration.mjs` runs the pre-registration contract against the sample-data server: the public form, then the front desk's queue with accept and reject.

```bash
cd contracts
npm run mock                                   # in one terminal
node tests/flows/pre-registration.mjs          # in another; BASE_URL=http://127.0.0.1:4020 for another port
```

- **The public form:**
  - `POST /portal/practices/{practiceLinkId}/pre-registrations`, with the practice's code from its link. The mock takes any code of 16 to 64 letters, digits, `_` or `-`.
  - It takes **no cookie at all**: it is `public` (D96). It needs an `Idempotency-Key`.
  - It always answers `204` with no body. The form screen shows the same "thank you" whatever happens, except for these answers, which say nothing about the person:
    - `Prefer: code=422`: a failed bot check, or a field error (including neither a phone nor an email);
    - `Prefer: code=404`: the practice's link is unknown or turned off;
    - `Prefer: code=403`: a wrong `Origin`;
    - `Prefer: code=429`: a rate limit.
- **The bot check:** the mock accepts any `botCheck` string. The real API verifies an ALTCHA payload on the server; the widget is added only after it passes the 7-day rule and the licence check (D75).
- **The queue** uses the staff mock session (§3):
  - `GET /pre-registrations?status=pending`, oldest first, with the insurance as typed in `details.insurance`;
  - accept with the `create` example, or `link` (to an existing patient after a `409 possible-duplicate`). Both carry the ID check (`identityVerified`, `idDocumentType`), and the answer records it in `identityCheck`;
  - reject with the `spam` or `other` example.
- **Today's result:** 16 of 16 calls pass.

## 5f. Check-out with the follow-up and the copay (demo steps 10–11, D98, D100)

`tests/flows/check-out.mjs` runs the end of the visit against the sample-data server: the clinician's follow-up request, then the front desk's check-out.

```bash
cd contracts
npm run mock                              # in one terminal
node tests/flows/check-out.mjs            # in another; BASE_URL=http://127.0.0.1:4020 for another port
```

- **The follow-up request:** `PUT /encounters/{encounterId}/follow-up` with the encounter's `If-Match`. It answers `412` (`Prefer: code=412`) when the visit changed since it was read. The clinician can withdraw an open one with `POST …/follow-up/withdraw` (`If-Match`, a reason).
- **At the desk:**
  - `GET /appointments/{appointmentId}` with `Prefer: example=at-check-out` carries `followUp`, `encounterId` and `visitStatus`;
  - so does the staff board (`view=staff`, `Prefer: example=staff`); the shared board never does (D47).
- **The copay** uses Anand's payment operations (D100):
  - `POST /payments/card-session`, then `POST /patients/{patientId}/payments` with the card session and the appointment;
  - `Prefer: code=422` gives the refusal for a session captured for another amount.
- **The after-visit summary:** the clinician generates it (`POST …/after-visit-summary`, MD and APP); the desk prints the latest one with `GET /encounters/{encounterId}/after-visit-summary/download-url` (`Prefer: code=404` until one exists).
- **The revisit:**
  - `POST /appointments` with the `revisit` example (`followUpOfEncounterId`) books it;
  - `Prefer: code=422` gives the refusal when the follow-up isn't open;
  - `POST /encounters/{encounterId}/follow-up/decline` (FD, ADM; `If-Match`, `Idempotency-Key`) records the patient's no instead.
- **Check-out:** `POST /appointments/{appointmentId}/check-out` (FD, ADM). The `checked-out` example shows the visit `checked-out` and the follow-up `booked` with `bookedAppointmentId`; `Prefer: code=409` gives the refusal that names what blocks it in `errors`.
- **Today's result:** 25 of 25 calls pass.

## 5g. Prescriptions (demo steps 7 and 9, D97, D99)

`tests/flows/prescriptions.mjs` runs the prescriptions slice against the sample-data server. Rooming records the current medications; the clinician searches the drug, drafts, checks, overrides, then signs and sends.

```bash
cd contracts
npm run mock                                # in one terminal
node tests/flows/prescriptions.mjs          # in another; BASE_URL=http://127.0.0.1:4020 for another port
```

- **Current medications:** `GET`/`POST /patients/{patientId}/medications`.
- **Drug search:** `GET /codes?system=rxnorm&q=…` with `Prefer: example=rxnorm`. The real API searches the RxNorm Current Prescribable Content. Each result carries `drug`: strength, dose form, route, ingredients with their RxCUIs, the brand name and, for a controlled substance, its DEA schedule (`controlledSchedule`).
- **The draft:**
  - `POST /prescriptions`, then `PATCH` with `If-Match`;
  - `Prefer: code=412` gives the stale-version refusal, and `code=409` the "signed, so locked" one.
- **The safety check:** `POST …/safety-check`, with `Prefer: example=allergy`, `duplicate` or `none`.
  - On the real API the alerts are fixed rules in code, never AI (D99).
  - A `high` alert needs `POST /alerts/{alertId}/override` with a reason before signing; `Prefer: code=422` on sign-and-send gives the refusal.
- **Sign and send:** `POST …/sign-and-send` with `If-Match` and an `Idempotency-Key`.
  - The prescription comes back with transmission `queued`.
  - On the real API it then goes through the outbox to the simulated pharmacy (D99), and `prescription.transmission-updated` reports `sent`, then `accepted` or `rejected`.
- **A wrong draft:** `POST …/entered-in-error` with a reason. A signed prescription answers `409`; it is cancelled instead (later batch).
- **Today's result:** 21 of 21 calls pass.

## 5h. Note templates for clinicians and the portal's medication list (demo steps 8 and 12)

`tests/flows/templates-and-portal-medications.mjs` runs both on the sample-data server:

```bash
cd contracts
npm run mock                                                # in one terminal
node tests/flows/templates-and-portal-medications.mjs       # in another; BASE_URL=http://127.0.0.1:4020 for another port
```

- **Note templates:** `GET /note-templates` and `GET /note-templates/{noteTemplateId}` need `note-templates:read` (MA, RN, MD, APP, ADM, CO). `Prefer: code=403` gives the front desk's refusal.
- **The portal's medication list:** `GET /portal/me/medications` with the mock **portal** cookie (§5d). It returns prescriptions with their transmission status, and reported medications. The staff cookie alone gets `401`.
- **Today's result:** 6 of 6 calls pass.

## 6. What the mock cannot do

| Limit | What it means for screens |
|---|---|
| **No real login or roles** | Every signed-in call is allowed. Test `403 permission-denied` and `403 break-glass-required` with `Prefer: code=403, example=…`. |
| **No state between calls** | A POST does not create anything: the next GET returns the fixed example, not what you sent. IDs in responses are the example IDs. |
| **Request errors are always `422`** | Prism reports any request it rejects (missing header, bad field) as `422` with the first `422` example. The real API returns `400` for a missing `Idempotency-Key` or unparseable JSON, and the right field errors (API_STANDARDS §9). Build the error display from the Problem `code`, not from these examples. |
| **No idempotency, ETag or state rules** | No replay of a repeated `Idempotency-Key`, no `412` on a stale `If-Match`, no `409` from the state machines unless you ask for it. |
| **No restricted-chart or facility rules** | The mock never hides fields of a restricted patient or rejects a facility. The real API does (SECURITY_MODEL §5). |
| **Long-running work never finishes** | `POST /eligibility-checks` and `POST /files/{fileId}/complete` return `202` with an operation, but `/operations/{operationId}` is not in batch 1. The same holds for the after-visit summary (batch 2). Read the result with `GET /eligibility-checks/{eligibilityCheckId}` and `Prefer: example=…`. |
| **No event stream** | `GET /events/stream` is in the contract (D52) but Prism cannot serve `text/event-stream` (it answers `500 NO_COMPLEX_OBJECT_TEXT`). Build the live-update code against the `EventEnvelope` schema and EVENTS.md §3; test it against the real API. |
| **Fixed times** | Examples use dates around 3 November 2026. |
| **Synthetic data only** | Never type real patient details into a screen connected to the mock, and never paste mock traffic containing real data into chats or tickets. |

Questions about an endpoint's shape go to Vimal as a comment on the contract pull request; the contract wins over this guide.
