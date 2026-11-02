# Note for Minalini — API contract items needing your decision

From: Vimal (drafted with Claude Code) · 2026-10-22 · Becomes GitHub issues once the repository exists (VD-LOC).

Each item has a **PROPOSED** answer already written into the documents so work can continue. Please reply "agree", or give your answer. Items marked **blocks Stage 3** are needed for the shared contract components; the mock server comes to you first (VG §4).

## Status after your sign-off (issue #5, 2026-10-22)

Applied in PR #2: M1, M2, M3 (`orval` with a custom mutator), M4 (one fetch wrapper; **your design task: the 412 "record changed" screen**), M5 (FRS v1.2 is the source for field lists), M6, M8 (your design task), M9, M11 (initials plus appointment time), M12, M13 (JPEG and PNG for P0; HEIC only if Anand's file service converts it), M14.

Vimal's answers to your questions:

- **M7:** yes, a full phone number is an identifier. It is only ever sent in the body of `POST /patients/search`, never in a URL. Exact match on the full number (normalized digits) only; no partial-number search in the MVP, because partial search makes it easy to fish through records (API_STANDARDS §14.2).
- **M15:** the idle timeout is 15 minutes (Thulasi, T9, pending the clinical advisors) and 12 hours absolute. Warn at 13 minutes, two minutes before logout, with a "Stay signed in" button that counts as user activity (calls `POST /auth/refresh`). **Confirmed by Thulasi** (issue #3): time the warning from `idleExpiresAt` returned by `GET /auth/session`, and show a notice before the 12-hour absolute limit (`expiresAt`), which cannot be extended. ADR-0006 stays Accepted (SECURITY_MODEL §2.1).

Still with you: M10 (EVENTS §4 review) and M16 (rows #220–226). Also: please review Thulasi's separate core PR changing `enqueue()` when it opens (core change, all four review).

## Original items

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| M1 | JSON property and query parameter casing (**blocks Stage 3**) | camelCase | API_STANDARDS §3 |
| M2 | List shape: `{ items, nextCursor }`, no total counts by default, "load more" rather than page numbers (**blocks Stage 3**) | Yes | API_STANDARDS §8, ADR-0004 |
| M3 | TypeScript client generator and data-fetching library | Your choice: `orval` 8.44.0 (types + hooks) or `openapi-typescript` 7.13.0 (types only), versions checked 2026-10-22 | TOOLCHAIN §1, §7 |
| M4 | Generated client must: send `X-CSRF-Token` on POST/PUT/PATCH; create one `Idempotency-Key` per user action and reuse it on retry; keep the latest `ETag` and handle `412`/`428` (reload, show difference); switch on Problem `code`, never on text | Agreed: one fetch wrapper handles CSRF, `ETag`/`If-Match` and Problem `code`; the `Idempotency-Key` is created per user action and reused on retry. **Minalini designs the 412 "record changed" screen** (her design task, as for M8) | SECURITY_MODEL §2.2, API_STANDARDS §9–§11 |
| M5 | Where are the existing screens? We need their field lists so the contract matches what they show | — | — |
| M6 | Patient search result fields (`PatientSummary`) | id, name, birth date, sex, MRN, `restricted`, last 4 digits of phone | SECURITY_MODEL §8 rule 4 |
| M7 | Patient search needs an exact identifier or two criteria (e.g. last name + birth date); at most 50 results | Yes | API_STANDARDS §14.2 |
| M8 | Screen flows driven by errors: `possible-duplicate` (show candidates, override with reason), `break-glass-required` (reason dialog), `session-expired` (re-login), `feature-disabled` (hide AI) | Please design | API_STANDARDS §9.3 |
| M9 | Long-running actions: `202` + operation; screen listens for `operation.completed` on the event stream or polls `GET /operations/{id}` | Yes | API_STANDARDS §13 |
| M10 | Screens that need live updates and which events | As in the "Browser" rows | EVENTS §4 |
| M11 | Status board on a waiting-room display: initials only | Yes | SECURITY_MODEL §9 |
| M12 | Mock server: run locally with `npx` and also a shared staging mock redeployed on merge; static examples first | Yes | TOOLCHAIN §7 |
| M13 | File uploads from the browser: request upload URL, `PUT` directly, then attach `fileId`; insurance-card types JPEG, PNG, HEIC (phones) | Please confirm HEIC is needed | API_STANDARDS §15 |
| M14 | Input formats: phone E.164, U.S. state as USPS two-letter code, ZIP or ZIP+4, dates `YYYY-MM-DD`, times shown in the facility's time zone | Yes | API_STANDARDS §6 |
| M15 | Login in the browser: redirect to `/api/v1/auth/login`; after return, `GET /auth/session` for user, CSRF token and idle expiry; warn before idle timeout | Yes (with Thulasi) | SECURITY_MODEL §2 |
| M16 | Sign off your rows (#220–226) | **Agreed** (issue #5, 2026-10-24), with your two additions: `GET /message-templates/{messageTemplateId}` (new #248) for the ETag, and an `active` flag to retire a template (`PATCH`, no DELETE). Both go into the communications contract (batch B3) | ENDPOINT_INVENTORY #220–226, #248 |
| M17 | **Your screen-mapping gaps, answered (2026-10-24, D49–D70).** Accepted in batch 1: booking lists `/booking/*` (D49), `preferredPharmacy` and `GET /pharmacies` (D50), `GET /patient-merges` (D51), sign-in, session, event stream and files contracts (D52), break-glass (D53), `POST /patients/summaries` (D54), undo check-in (D55), license image as a document (D56), preferred and previous names (D57), copay payment with receipt (D58), consent requirements (D59), status board fields (D60), reschedule action (D61), `dateFrom`/`dateTo` (D62). Decided: duplicates in the admin portal only (D64), no all-patients list (D65), schedule blocks by FD and ADM (D66), clinicians read-only on appointments (D67), AI features hidden or removed (D68), U.S. vital units (D69), AI shapes from your Stage 3 (D70). Later batches: ENDPOINT_INVENTORY "Later batches". | Please wire the screens to these | DECISIONS D49–D70; ENDPOINT_INVENTORY #236–247 |
| M18 | **Batch 3: inbox (2026-10-26; D77–D81).** The contract for your later-batch item is written: `POST /messages` with `kind: task`, an assignee (user or role), due time, optional patient and linked record; clinicians ask for appointment changes this way (D67). For the screens: badge counts from `GET /inbox/summary`; take an item from a queue with `PATCH { assignee: me }` and `If-Match` (a `412` means a colleague took it first); kinds that wait for an action have no "Done" button (the action completes them, D77); an item with `restricted: true` shows no patient; read / unread is P1. Any notification you send outside the app says only "You have a new item in Shri Health" (D81). | Please review the inbox contract for the screens | `contracts/openapi/modules/inbox.yaml`; BATCH3_PLAN.md |
| M19 | **Contracts follow-up 2 (2026-10-26), your three requests on #48 and D39.** (1) `GET /patients/{patientId}/coverages/{coverageId}` returns one coverage with its strong `ETag`, so "end coverage" (`PATCH` with `endDate`, D45) can be built; the same for related persons. (2) Gender identity codes are pinned to US Core 9.0.0 (D82): exactly your five, SNOMED CT `446141000124107`, `446151000124109`, `33791000087105`, data-absent-reason `asked-declined` for "prefer not to say", NullFlavor `UNK`; anything else is refused. (3) Birth sex stays `F`, `M`, `UNK` for now (the 9.0.0 value set also has `asked-declined`, `ASKU`, `OTH`; adding them is an additive change if you need "declined" told apart). (4) **The registration screen reads `GET /me` → `practiceSettings.registration.showSexualOrientationAndGenderIdentity`** and shows the sexual-orientation and gender-identity fields only when it is true (D39, off until the practice turns it on); the fields stay optional either way. | Please review | `contracts/openapi/modules/patients.yaml`, `platform.yaml`; DECISIONS D39, D82 |
| M20 | **Portal batch B8a is in the contract (2026-10-26, D89).** Once it merges, regenerate the client and move these screens from your mock to it: (1) **activation first:** `POST /portal/enrollments` with code, date of birth and email answers `204`, then shows "check your email"; sign-in (`/portal/auth/login`) comes after, as in ADR-0013 §3; one message for any `422`; (2) session handling as `session.tsx`, against `/portal/auth/session`, `/refresh` and `/logout`; (3) **alerts** come from `GET /portal/me/appointments?when=upcoming` (there's no `/portal/me/alerts`); (4) cancelling needs a reason; booking uses `GET /portal/me/slots` and the `/portal/booking/*` lists, and a `409 booking-conflict` re-reads the free times; (5) visit summaries open through `…/download-url`, and a held item shows "held by your clinician" with no link (D86); (6) demographics edits are change requests, shown as pending from `GET /portal/me`; (7) the "Source code" link is `/source.tar.gz` (ADR-0013 §1). **Staff patient page:** a portal account panel from `GET /patients/{patientId}/portal-account` with "Print invitation" (the code is in the response once, so print it then), "Revoke" and "Reset sign-in factors", both after an ID-check confirmation. Messages, results, prescriptions, documents, forms, bills, exports and video stay on your mock until B8b. **Your six requests on #73, now in the contract:** (1) a past appointment carries `visitSummaryId`; (2) problems can be held (`releaseStatus`, D90), allergies and vitals never; (3) preferred language, race, ethnicity and marital status on the profile and in change requests, sexual orientation and gender identity only where the practice shows them (D91); (4) the server accepts invitation codes in any case and with or without dashes; (5) enrollment checks `Origin`, so a `403` can come back; (6) **Disable** and **Enable** on the staff portal-account panel, ADM only, each asking for a reason (D92); a `suspended` account (its chart was merged) shows no Enable button: undoing the merge restores it. | Please review the PR | ENDPOINT_INVENTORY "Later batches: patient portal"; ADR-0013 |
| M21 | **The first `/hooks` operation is in the contract (D94):** `POST /hooks/keycloak/backchannel-logout`, for Keycloak, never for browsers. `orval.config.ts` has no tag filter, so the next `npm run generate` would add it to the client. Suggest excluding the `partner-callbacks` tag there (your file), as its tag description says. Nothing changes on the screens: a session Keycloak ends simply gets `401` on the next call, which `session.tsx` already handles. | Please review | D94 |
| M22 | **Pre-registration (D96, demo step 1 on #85; updated after your #89 review).** The public form is served under the practice's own link and posts to `POST /portal/practices/{practiceLinkId}/pre-registrations` (no session) with the ALTCHA widget and an `Idempotency-Key`. It has no facility field, and needs at least one phone or email. It always gets the same `204`, so the screen shows one "Thanks, we'll be in touch" message whatever happens. Separate messages only for a field error or failed bot check (`422`), a rate limit (`429`) and an unknown link (`404`). The front desk's queue: `GET /pre-registrations` (pending first; the insurance as typed is in `details.insurance`), the detail, accept (which asks the user to confirm the ID check and its type, then creates the patient, or links an existing one after a `409 possible-duplicate`) and reject with a reason. MOCK_GUIDE §5e runs it (`tests/flows/pre-registration.mjs`). | Please review | D96; ENDPOINT_INVENTORY #293–297 |
| M23 | **Check-out with the follow-up and the copay (D98, D100; demo steps 10–11 on #85; updated after your #91 review).** (1) In the visit, the clinician sets the follow-up with `PUT /encounters/{encounterId}/follow-up` (`If-Match` on the encounter): interval (counted from the visit's date in the facility's time zone), optional type, provider and note. The clinician can withdraw an open one (`POST …/follow-up/withdraw`, with a reason); declining is the desk's. (2) At check-out, `GET /appointments/{appointmentId}` (example `at-check-out`, now with `encounterId` and `visitStatus`) and the staff status board carry `followUp` (interval, type, provider, status, and `bookedAppointmentId` once booked); the shared board never does. (3) Book the revisit with `POST /appointments` and `followUpOfEncounterId`, or record the patient's no with `POST /encounters/{encounterId}/follow-up/decline` (FD, ADM; reason, `If-Match`, `Idempotency-Key`). A cancelled revisit reopens the request; a rescheduled one stays booked. (4) The copay uses the batch 1 payment operations (`POST /payments/card-session`, then `POST /patients/{patientId}/payments` with `appointmentId`). (5) Print the summary with `GET /encounters/{encounterId}/after-visit-summary/download-url` (`404` until one exists). (6) Check-out is `POST /appointments/{appointmentId}/check-out` (FD, ADM; example `checked-out`); its `409` names what blocks it in `errors` (`/followUp`, `/status`). MOCK_GUIDE §5f runs it (`tests/flows/check-out.mjs`). | Please review | D98, D100; ENDPOINT_INVENTORY #298–299, #301–303 |
| M24 | **Prescriptions (D97; demo steps 7 and 9 on #85).** (1) Rooming's current medications: `GET`/`POST /patients/{patientId}/medications`. (2) Drug search: `GET /codes?system=rxnorm&q=` (example `rxnorm`). Each result carries `drug`, as you and Anand listed on #13: `strength`, `doseForm`, `route`, `ingredients` (each with `rxcui` and `name`), `brandName` for a branded product, and `controlledSchedule` (`CII` to `CV`) for a controlled substance, to show before signing. (3) The draft: `POST /prescriptions`, then `PATCH` with `If-Match`; a wrong draft is marked with `POST …/entered-in-error`. (4) The safety check: `POST …/safety-check` returns the alerts (examples `allergy`, `duplicate`, `none`); a `high` alert shows an override with a required reason (`POST /alerts/{alertId}/override`). (5) Sign and send: `POST …/sign-and-send` with `If-Match` and an `Idempotency-Key`; then show the transmission status (`queued`, `sent`, `accepted`, `rejected`) as `prescription.transmission-updated` arrives. MOCK_GUIDE §5g runs it (`tests/flows/prescriptions.mjs`). | Please review | D97; ENDPOINT_INVENTORY #116–117, #120–125, #227 |
| M25 | **Note templates for clinicians and the portal's medication list (demo steps 8 and 12 on #85).** (1) The clinician's template picker calls `GET /note-templates` with `note-templates:read` (MA, RN, MD, APP, ADM, CO); FD gets `403`. (2) The portal's prescription step reads `GET /portal/me/medications`: prescriptions with their transmission status (`queued`, `sent`, `accepted`, `rejected`, `error`) and reported medications, active first. It replaces the prescriptions part of your portal mock. MOCK_GUIDE §5h runs both (`tests/flows/templates-and-portal-medications.mjs`). | Please review | ENDPOINT_INVENTORY #183–186, #300 |
| M26 | **Your #93 review (2026-10-27).** (1) Signing refuses with `422 business-rule-violation` and one `errors` entry per refusal: `safety-check-stale` at `/alerts` (run the check again) and `override-required` at `/alerts/{i}` (override the alert at that index), plus `required` at `/dosageText`, `/quantity` or `/pharmacyId`. The mock serves `Prefer: code=422, example=safety-check-stale`, `override-required` or `missing-fields` (MOCK_GUIDE §5g). (2) The check and the override don't change the draft's `ETag`. `safetyCheckedAt` on the prescription is present only when the check ran on this version, so after a reload the screen knows whether to run it again. (3) The override reason needs at least 3 characters, not counting spaces at either end. D99 is in DECISIONS since #84. | Please review | `medications.yaml`; MOCK_GUIDE §5g |
| M27 | **The clinician's part of the demo, steps 7, 8, 9, 10 and 12 (D108), and the check-out revisit:** for each step, the screen, the operations in order, a shortened example and the errors the screen must handle. See [M27 below](#m27--demo-steps-7-8-9-10-and-12-d108). | Please wire the screens to these | `encounters.yaml`, `medications.yaml`, `scheduling.yaml` |

## M27 — Demo steps 7, 8, 9, 10 and 12 (D108)

From: Vimal (drafted with Claude Code) · 2026-11-02.

**Where the order comes from:** the preview run of 31 October (`demo_story.json` and the script that produced it). That run passed steps 7, 8, 10 and 12. Step 9 signed the prescription and queued it, but the worker had no simulated-pharmacy adapter yet, so it was never sent. The run records the operations and status codes only, not the bodies. So the requests below are the ones that run sent, and the responses are the contract's own examples. All data is synthetic. Examples marked *(shortened)* leave out fields; `…` marks where.

**Step numbers:** these are D108's. D108, D109 and D110 are in Vimal's PR #164 (not merged yet); D107 is in #170.

**Backend status:**
- Steps 7, 8 and 12 are built: diagnoses, notes, signing, addenda, co-sign and close are in PR #165, and booking is on main.
- Step 10 (`setFollowUpRequest`, `withdrawFollowUpRequest`) is in draft PR #161.
- Step 9 is in PR #169 (not merged).
- Until those merge, the mock serves them.

### Errors every step can return

| Status and `code` | When | What the screen does |
|---|---|---|
| `403 break-glass-required` | The chart is restricted and the user has neither a break-glass grant nor a place on the care team (D37). | Show the break-glass reason dialog (M8, D53), then retry. Care-team members never see this. |
| `403 permission-denied` | The role lacks the permission, or a rule about who may act refuses it (for example, not the note's author). | Hide or disable the action. Don't offer a retry. |
| `404 not-found` | Another clinic's record, a facility that isn't the user's, or a draft note read by BIL. | Treat as gone. |
| `409 record-locked` | The note is signed (D8). Once a note on the visit is signed, its diagnoses are locked too (D24). | Offer **Add addendum** instead of editing. |
| `409 invalid-state-transition` | The record isn't in a state that allows this. The problem's `currentState` says which state it is in (for example `final`, `finished`, `entered-in-error`). | Reload, and show the state. |
| `412 precondition-failed` | The `If-Match` is stale: someone, or another tab, saved first. The response's `ETag` header is the current version. | Show the "record changed" screen (M4), then reload. |
| `428 precondition-required` | `If-Match` is missing. | A client bug: the fetch wrapper always sends the latest `ETag` (M4). |

Every `422 business-rule-violation` lists each refusal in `errors` (`pointer` and `code`). Show each one next to its field.

### Step 7 — Diagnoses

**Screen:** the visit workspace (to build; `RoomingPage` is the nearest existing screen). The doctor opens it after rooming.

**Calls, in order:**
1. `recordVisitStatus` (`with-provider`, from scheduling).
2. `getEncounter` (keep its `ETag`).
3. `searchCodes` (`system=icd-10-cm`).
4. `addEncounterDiagnosis`.
5. `removeEncounterDiagnosis`, only to take a diagnosis off before signing.

```http
POST /api/v1/encounters/{encounterId}/diagnoses
{"code": {"system": "http://hl7.org/fhir/sid/icd-10-cm", "code": "I10"}}

201 Created   (shortened)
{"id": "8a9b0c1d-…", "encounterId": "5d6e7f8a-…", "rank": 1,
 "code": {"system": "http://hl7.org/fhir/sid/icd-10-cm", "code": "I10",
          "display": "Essential (primary) hypertension"},
 "verificationStatus": "confirmed", "recordedBy": {"displayName": "Dr. Lowe58"}, …}
```

The display shown is always the terminology's, not the client's. An optional `rank` inserts the diagnosis at that place and moves the others down.

```http
POST /api/v1/encounters/{encounterId}/diagnoses/{diagnosisId}/remove
{"reason": "Added to the wrong encounter."}

200 OK   (shortened)
{"id": "8a9b0c1d-…", "verificationStatus": "entered-in-error", …}
```

**After a removal:**
- The diagnosis is kept for audit, but it disappears from the workspace's `diagnoses`.
- The diagnoses below it move up a rank.
- The real API leaves `rank` out of the response; the contract example shows `"rank": null`. Treat the two the same.

**Errors:**
- `403 break-glass-required`.
- `409 record-locked` once a note on the visit is signed. After signing, a wrong diagnosis is corrected by an addendum. `markDiagnosisEnteredInError` isn't built yet (it waits on Anand).
- `409 invalid-state-transition` when removing a diagnosis that is already removed.
- `422` with one of these at `/code/code`: `not-allowed-value` (a non-billable header code such as `E11`), `invalid-reference` (an unknown code) or `conflicting-fields` (the code is already on the visit); or at `/rank`, a rank that would leave a gap.
- No `If-Match` on these two calls, so no `412` or `428`.

### Step 8 — Templated note, sign, addendum, co-sign

**Screen:** the note editor in the visit workspace.

**Calls, in order:**
1. `listNoteTemplates`.
2. `createNote`.
3. `updateNoteDraft`, the autosave, with `If-Match`, at most every 30 seconds.
4. `signNote`, with `If-Match`.
5. `addNoteAddendum`, with `If-Match`, after signing.
6. `cosignNote`, with `If-Match`, by the co-signer only.

```http
POST /api/v1/encounters/{encounterId}/notes
{"templateId": "1d2e3f4a-…"}

201 Created   ETag: "1"   (shortened)
{"id": "6e7f8a9b-…", "status": "preliminary", "cosignStatus": "not-required",
 "title": "Follow-up visit",
 "sections": [{"id": "2e3f4a5b-…", "code": "10154-3", "title": "Chief complaint",
               "required": true, "text": ""}, …],
 "addenda": [], …}
```

The first note moves the encounter to `in-progress`.

```http
PATCH /api/v1/notes/{noteId}   If-Match: "1"   Content-Type: application/merge-patch+json
{"sections": [{"id": "2e3f4a5b-…", "text": "Headaches for two weeks."}]}
→ 200 OK   ETag: "2"

POST /api/v1/notes/{noteId}/sign   If-Match: "2"
→ 200 OK   (shortened)
{"status": "final", "cosignStatus": "pending",
 "cosigner": {"displayName": "Dr. Hessel21"}, "signedAt": "…",
 "signedBy": {"displayName": "Dr. Lowe58"}, …}

POST /api/v1/notes/{noteId}/addenda   If-Match: <ETag from sign>
{"text": "Home blood pressure log reviewed: within goal."}
→ 200 OK   (shortened)
{"status": "amended", "addenda": [{"text": "Home blood pressure log reviewed: within goal.", …}], …}

POST /api/v1/notes/{noteId}/cosign   If-Match: <current ETag>
{"decision": "cosign"}
or {"decision": "return", "comment": "Please add the home readings."}
```

**About the calls:**
- `cosignStatus` is `pending` only when a co-sign rule covers the author. Otherwise it is `not-required`, and step 6 doesn't happen.
- A returned note stays signed. The author answers with an addendum, which makes it `pending` again.

**Errors:**
- `428` on the autosave or the sign without `If-Match`.
- `412` when another tab saved first. The response's `ETag` header is the current version.
- `422` on sign: one `required` entry for each empty required section, at `/sections/{i}/text`.
- `409 record-locked` on any `PATCH` after signing.
- `409 invalid-state-transition`: signing twice (`currentState: final`), co-signing a note that isn't `pending`, or writing a note on a closed visit (`finished`).
- `403 permission-denied` when someone other than the author edits or signs, or when the co-sign comes from anyone but the named co-signer (the author included).
- `403 break-glass-required` on every call for a restricted chart. A care-team member co-signs without break-glass.

### Step 9 — Prescribe

**Screen:**
- `DrugPicker` and `MedicationsSection` (features/clinical), from the visit workspace.
- Prescribing is MD and APP only (D110, PR #164).

**Calls, in order:**
1. `searchCodes` (`system=rxnorm`).
2. `createPrescription`.
3. `updatePrescription` with `If-Match`, only when editing the draft.
4. `checkPrescriptionSafety`.
5. `overrideAlert`, once for each `high` alert.
6. `signAndSendPrescription`, with `If-Match` and `Idempotency-Key`.
7. `getPrescription`, or the `prescription.transmission-updated` event, for the transmission status.

```http
POST /api/v1/prescriptions
{"patientId": "7a1b2c3d-…", "encounterId": "2b3c4d5e-…",
 "medication": {"codings": [{"system": "http://www.nlm.nih.gov/research/umls/rxnorm",
                             "code": "308191", "display": "amoxicillin 500 MG Oral Capsule"}]},
 "dosageText": "1 capsule by mouth three times daily for 10 days",
 "quantity": {"value": 30, "unit": "capsule"}, "daysSupply": 10, "refills": 0,
 "substitutionAllowed": true, "pharmacyId": "9d0e1f2a-…"}
→ 201 Created   ETag: "1"   (shortened)
{"id": "6a7b8c9d-…", "status": "draft", "transmission": {"status": "not-sent"}, "alerts": [], …}

POST /api/v1/prescriptions/{prescriptionId}/safety-check
→ 200 OK
{"prescriptionId": "6a7b8c9d-…", "checkedAt": "…",
 "alerts": [{"id": "8c9d0e1f-…", "kind": "allergy", "severity": "high",
             "message": "Active allergy to penicillin; amoxicillin is a penicillin.",
             "overrideRequired": true}]}

POST /api/v1/alerts/{alertId}/override
{"reason": "Tolerated amoxicillin in 2024 without reaction."}
→ 200 OK   (the alert, with its override)

POST /api/v1/prescriptions/{prescriptionId}/sign-and-send   If-Match: "1"   Idempotency-Key: <one per click>
→ 200 OK   (shortened)
{"status": "active", "transmission": {"status": "queued", "updatedAt": "…"}, "signedAt": "…", …}
```

The transmission status then moves through `queued`, `sent`, and `accepted` or `rejected`.

**Errors:**
- `422 business-rule-violation` on sign-and-send, one entry for each refusal:
  - `safety-check-stale` at `/alerts`: run the check again.
  - `override-required` at `/alerts/{i}`: override that alert.
  - `required` at `/dosageText`, `/quantity` or `/pharmacyId`.
- `409 record-locked` on `PATCH` once the prescription is signed.
- `409 invalid-state-transition` for a safety check, an override or a sign-and-send on a prescription that isn't a draft (`currentState`).
- `412` and `428` on `PATCH` and sign-and-send.
- `403 break-glass-required` on a restricted chart.

### Step 10 — Follow-up request

**Screen:** the visit workspace (the doctor). The front desk sees the result at check-out (M23).

**Calls, in order:**
1. `getEncounter`, for the encounter's `ETag`.
2. `setFollowUpRequest`, with `If-Match`.
3. `withdrawFollowUpRequest`, with `If-Match`, only to withdraw an open request (only the clinician who asked for it may).

```http
PUT /api/v1/encounters/{encounterId}/follow-up   If-Match: <encounter ETag>
{"interval": {"value": 2, "unit": "week"}, "appointmentTypeId": "7a8b9c0d-…",
 "providerId": "6f7a8b9c-…", "note": "Recheck blood pressure."}
→ 200 OK   ETag: <new encounter ETag>   (shortened)
{"interval": {"value": 2, "unit": "week"}, "status": "open", "requestedBy": "6f7a8b9c-…",
 "requestedAt": "…", …}
```

**About the call:** the follow-up is part of the encounter. Saving it changes the encounter's `ETag`, so keep the new one for the next encounter write.

**Errors:**
- `428` and `412`, against the encounter's version.
- `409 invalid-state-transition` when the request is already booked, or the encounter is entered in error or cancelled (`currentState`).
- `403 permission-denied` on withdraw by anyone but the clinician who asked.
- `403 break-glass-required` on a restricted chart. At the desk, D107 (PR #170) exempts check-out and declining, not this call.

### Step 12 — Book the revisit

**Screen:** `BookAppointmentDialog` (features/scheduling), opened from check-out with the follow-up request filled in (M23).

**Calls, in order:**
1. `listSlots`.
2. `bookAppointment`, with `followUpOfEncounterId` and an `Idempotency-Key`.
3. Then `checkOutAppointment` (M23).

```http
GET /api/v1/slots?providerId=…&facilityId=…&appointmentTypeId=…&date=2026-11-16
→ 200 OK   {"items": [{"startAt": "…", "overbook": false, …}, …], "timeZone": "America/Chicago"}

POST /api/v1/appointments   Idempotency-Key: <one per click>
{"patientId": "7a1b2c3d-…", "providerId": "6f7a8b9c-…", "facilityId": "8b9c0d1e-…",
 "appointmentTypeId": "0d1e2f3a-…", "startAt": "2026-11-16T15:00:00Z",
 "reasonForVisit": "Recheck blood pressure.", "followUpOfEncounterId": "2f3a4b5c-…"}
→ 201 Created   (shortened)
{"id": "1e2f3a4b-…", "status": "booked", "startAt": "2026-11-16T15:00:00Z",
 "timeZone": "America/Chicago", …}
```

In the same transaction, the follow-up request becomes `booked`, with `bookedAppointmentId`.

**Errors:**
- `409 booking-conflict`: the slot was taken. Read the free times again.
- `409 patient-merged`.
- `422` with `invalid-reference` at `/followUpOfEncounterId`: no open follow-up request for this patient, or it is already booked.
- `422 business-rule-violation`: outside the provider's hours, or the overbook limit is reached.
- `404 not-found`: the facility isn't one of the user's.
- No `If-Match` and no `break-glass-required`: booking needs neither.
