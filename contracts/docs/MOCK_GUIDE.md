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

## 6. What the mock cannot do

| Limit | What it means for screens |
|---|---|
| **No real login or roles** | Every signed-in call is allowed. Test `403 permission-denied` and `403 break-glass-required` with `Prefer: code=403, example=…`. |
| **No state between calls** | A POST does not create anything: the next GET returns the fixed example, not what you sent. IDs in responses are the example IDs. |
| **Request errors are always `422`** | Prism reports any request it rejects (missing header, bad field) as `422` with the first `422` example. The real API returns `400` for a missing `Idempotency-Key` or unparseable JSON, and the right field errors (API_STANDARDS §9). Build the error display from the Problem `code`, not from these examples. |
| **No idempotency, ETag or state rules** | No replay of a repeated `Idempotency-Key`, no `412` on a stale `If-Match`, no `409` from the state machines unless you ask for it. |
| **No restricted-chart or facility rules** | The mock never hides fields of a restricted patient or rejects a facility. The real API does (SECURITY_MODEL §5). |
| **Long-running work never finishes** | `POST /eligibility-checks` and `POST /files/{fileId}/complete` return `202` with an operation, but `/operations/{operationId}` is not in batch 1. Read the result with `GET /eligibility-checks/{eligibilityCheckId}` and `Prefer: example=…`. |
| **No event stream** | `GET /events/stream` is in the contract (D52) but Prism cannot serve `text/event-stream` (it answers `500 NO_COMPLEX_OBJECT_TEXT`). Build the live-update code against the `EventEnvelope` schema and EVENTS.md §3; test it against the real API. |
| **Fixed times** | Examples use dates around 3 November 2026. |
| **Synthetic data only** | Never type real patient details into a screen connected to the mock, and never paste mock traffic containing real data into chats or tickets. |

Questions about an endpoint's shape go to Vimal as a comment on the contract pull request; the contract wins over this guide.
