# Batch 1 implementation plan: patients, scheduling, eligibility (Stage A)

Owner: Vimal (drafted with Claude Code) · 2026-10-27 · Branch `vimal/impl-batch1` from `main` (`dd36d41`) · **Approved by Vimal on 2026-10-27, with the decisions in §7.**

**Revision 2 (2026-10-27, approved by Vimal the same day; recorded as D95):** adds §8, the plan for the **demo on 20 November**: a complete patient visit on the real system, across the patient, front-desk and clinician portals. It covers the gaps in the contract (pre-registration, the prescriptions slice, follow-up and check-out, the portal's medication list), Vimal's PR order to the three checkpoints (Tuesday 3, Tuesday 10 and Tuesday 17 November), and what is needed from each teammate, with dates. §1–§7 are unchanged.

**Revision 3 (2026-10-27):** the dates are corrected (checkpoints Tuesday 3, 10 and 17 November; rehearsals Wednesday 18 and Thursday 19 November; demo Friday 20 November), and §8.3–§8.6 now hold each person's confirmed deliverables and dates from their replies on the tracking issue (#85). Recorded as D95 (dates) and D99–D102. The goal, story, checkpoint dates and cut order are recorded as D95, so they are decided rather than provisional (D10).

Read for this plan:
- `backend/app/core/` (`require()`, `tenant_db`, `errors.py`, `permissions.py`, the development login);
- `backend/app/db/CLAUDE.md` and `docs/contract_mapping.yaml`;
- migrations 0005 (#52), 0006 (#69) and 0007 (#74), all still open;
- the batch 1 contract (`patients.yaml`, `scheduling.yaml`, `eligibility.yaml`: 43 operations);
- DATA_OWNERSHIP §2.1, §3–§5;
- SECURITY_MODEL §3, §5 and §10;
- API_STANDARDS §8, §10 and §11;
- EVENTS;
- DECISIONS.

## 0. What exists today, and what doesn't

| Piece | State on `main` | Who |
|---|---|---|
| `require()`, `tenant_db`, Problem Details, permission catalogue | **Built** (`core/deps.py`, `errors.py`, `permissions.py`) | Thulasi |
| Development login (`X-Dev-User`: `fd`, `ma`, …, `none`, `md-b` in clinic B) | **Built**; real login later; endpoint code doesn't change | Thulasi |
| Audit written from `x-audit` (fails closed) | **Not built** (SECURITY_MODEL §3 step 8, §10) | Thulasi |
| Facility scope: `facilityId` not assigned → `404`, and a helper limiting lists to the user's facilities | **Not built** (SECURITY_MODEL §5.1, §10) | Thulasi |
| Break-glass check: restricted chart → `403 break-glass-required`, care team and grants (D37) | **Not built** ("the shared helper", §10) | Thulasi |
| Idempotency: store and replay keyed responses | **Not built** (§10 "pending Thulasi"); table `admin.idempotency_record` in #52 | Thulasi, #52 |
| Events: `publish()` in the request's transaction | **Not built**; table `admin.event_log` in #52 | Thulasi, #52 |
| Operations (`202` and `GET /operations/{id}`) | **Not built**; table `admin.operation` in #52 | Thulasi, #52 |
| Outbox: `enqueue(db, partner, message_type, payload, idempotency_key, ordering_key=None)` | **Not built** (T29, a core PR that all four review) | Thulasi |
| Cursor encryption (AES-GCM, T22) | **Not built** | Thulasi |
| FHIR write helpers (`fhir_store.create/update/entered_in_error`) | **Not built**; "flag it if you need it" (`db/CLAUDE.md`) | Anand |
| Contract-to-column mapping, follow-up (m) | **Not done**: 191 "not mapped yet" on `main`. #45 requires it **before any endpoint PR that uses those tables merges** | Anand |
| MRN counter and `next_mrn()`, D39 columns, employer, `selfPay`, required facility time zone | **#74, open** (changes requested) | Anand |
| Practice-setup reads: facilities, locations, providers, appointment types, provider schedules | **Not built** (Anand's module) | Anand |
| Pharmacy directory (`preferredPharmacy`), payer directory (coverage payor) | **Not built** (Thulasi's pharmacies, Anand's payers) | Thulasi, Anand |
| File service (insurance card images) | **Not built** | Anand |

### Rule I keep
**No module reads or writes another module's tables** (DATA_OWNERSHIP §3.1.4).
- Scheduling reads practice setup through **Anand's** service.
- Preferred pharmacy goes through **Thulasi's** pharmacy service, and coverage payors through **Anand's** payer service.
- Card images go through **Anand's** file service.

The interfaces I need are in §6, as notes for each owner.

## 1. Module layout

Every module follows `api.py → service.py → repository.py → schemas.py` (root `CLAUDE.md`). Each module has its own `tests/`. The router is found automatically (`core/routing.py`).

```
backend/app/modules/
  patients/
    api.py           routes only: one per contract operation, operation_id = the contract's operationId,
                     Depends(require(<x-permission>)) and Depends(tenant_db); sets ETag and Location;
                     names the audit patient when it isn't in the path (§10 duty)
    schemas.py       Pydantic v2 models generated from the contract's shapes: camelCase aliases,
                     extra="forbid" where the contract says additionalProperties: false
    service.py       rules: registration, duplicate check, restrict, merge, undo merge
    matching.py      the duplicate scoring (pure functions, unit-tested without a database)
    repository.py    queries on Anand's models; contract field ↔ column per contract_mapping.yaml;
                     version checks for If-Match; no business rules
    tests/           conftest (app client per dev user, synthetic seed), one file per area
  scheduling/
    api.py, schemas.py, repository.py
    service.py       booking, reschedule, cancel, status, check-in, undo check-in
    slots.py         free times: rules − exceptions − booked (pure, in the facility's time zone, D40)
    board.py         status board, staff and shared views (D47, D60)
    tests/
  eligibility/
    api.py, schemas.py, repository.py
    service.py       queue_check(db, coverage, appointment, trigger) for booking, check-in, the pre-visit
                     batch and the manual POST; record_response(db, ...) for Thulasi's 271 webhook handler
    tests/
  encounters/        (batch 1 needs only the service; its routes come with batch 2)
    service.py       open_for_check_in(db, appointment) and mark_entered_in_error(db, encounter, reason)
    repository.py
    tests/
```

### Cross-module calls (service to service, never another module's tables)
- **scheduling → patients:** `get_bookable_patient` (exists, not merged).
- **scheduling → encounters:** check-in and its undo.
- **scheduling → eligibility:** `queue_check` at booking and check-in.
- **eligibility → patients:** the primary coverage.

### Shared helpers
ETag formatting, cursor encoding, the facility filter and the audit-patient hook belong in core (§6). Until then, ETags are built in each repository from `meta_version_id` (clinical) or `version` (admin), quoted, as API_STANDARDS §11 says.

## 2. Operations

**Legend:**
- **Tx** is the transaction boundary; everything listed commits together (DATA_OWNERSHIP §3.1).
- **W** means written, **R** means read.
- **Audit** is the contract's `x-audit` (written by core). "Patient" says where the patient ID comes from; for `result` and `body:`, the endpoint names the patients through core's hook.
- **Idem.:** "S" means `Idempotency-Key` supported, "R" means required; both are handled by core's middleware. The service is written to be safe to retry anyway.
- **ETag:** a strong ETag on every single-resource response; `If-Match` required where the contract marks `if-match-required` (`428` if missing, `412` with the current ETag on mismatch).

### 2.1 Patients (`patients`): 25 operations

| Operation | Service | Tables (W / R) | Tx | Events | Audit | Idem. | ETag |
|---|---|---|---|---|---|---|---|
| `POST /patients/search` | `search(criteria, cursor)` | R `patient`, `human_name`, `identifier`, `contact_point` | read | — | R/phi-read, patients from the result | — | — |
| `POST /patients` | `register(body)`: duplicate check (similar name and the same date of birth or phone) → `409 possible-duplicate` with candidate IDs only, unless `duplicateCheck: override` with a reason; then the MRN from `admin.next_mrn()` (D41), called **last** so the counter lock is short | W `patient`, `human_name`, `contact_point`, `address`, `identifier` (MR + any sent), `patient_race_ethnicity`, `patient_communication`, D39 columns, `employer`; R `duplicate_candidate` source data | **one**: patient, children, MRN identifier, override reason, audit, event | `patient.created` | C/phi-write, result | S | ETag + `Location` |
| `GET /patients/{id}` | `get(id)` | R the patient and children, `patient_pharmacy`, the restriction | read | — | R/phi-read, path | — | ETag |
| `PATCH /patients/{id}` | `update(id, patch, if_match)` | W patient and child rows (replace lists) | one | `patient.updated` | U/phi-write, path | — | If-Match → new ETag |
| `GET`/`POST …/identifiers` | `list_identifiers` / `add_identifier`; refuses the practice's MRN system (an MRN only comes from the counter, D41) | W `identifier` | one | `patient.updated` | path | S (POST) | parent's ETag |
| `GET`/`POST …/related-persons`, `PATCH …/{relatedPersonId}` | related persons and their employer | W `related_person`, `related_person_relationship`, `employer` | one | — | path | S (POST) | If-Match on PATCH |
| `GET`/`POST …/coverages`, `PATCH …/{coverageId}` | coverage; payor through Anand's payer service; ends by `endDate` (D45) | W `coverage`, `coverage_payor`, `coverage_class`, `coverage_cost_to_beneficiary` | one | — | path | S (POST) | If-Match on PATCH |
| `POST …/coverages/{id}/entered-in-error` | `coverage_entered_in_error(id, reason)` (D45), with its Provenance | W `coverage`, `provenance`, `provenance_agent` | one | — | E/phi-write | — | ETag |
| `POST …/coverages/{id}/card-images` | through Anand's file service; stores the file ID only | W `coverage_card_image` | one | — | C/phi-write | S | — |
| `GET`/`POST …/consents` | insert-only; revoking is a new version | W `consent`, `consent_category`, `consent_performer`, `consent_verification` | one | — | path | S | — |
| `PUT …/preferred-pharmacy` | through Thulasi's pharmacy service (D50) | W `patient_pharmacy` | one | — | U/phi-write | — | If-Match |
| `POST …/restrict`, `…/unrestrict` | sets `meta_security` R or V (§5.2) | W `patient` | one | — | E/security | — | ETag |
| `GET /duplicates` | ADM only (D64) | R `duplicate_candidate`, `duplicate_match_evidence` | read | — | result | — | — |
| `POST /duplicates/{id}/merge` | locks both patients, lower UUID first (DATA_OWNERSHIP §4); `patient_link` `replaced-by`/`replaces`; re-points this module's rows; other modules re-point on `patient.merged` (EVENTS); a portal account is suspended (ADR-0013, #67) | W `patient_merge`, `patient_merge_record`, `patient_link`, `patient`, `duplicate_candidate` | **one** | `patient.merged` | E/phi-write, result (both IDs) | S | — |
| `POST /duplicates/{id}/dismiss` | `not-duplicate` with a reason (D46) | W `duplicate_candidate` | one | — | E/security, both IDs | S | — |
| `POST /patient-merges/{id}/undo`, `GET /patient-merges` | undo while allowed (D51); needs `UndoMergeRequest.reason` (#45 follow-up c) | W the merge tables, `patient_link`, `patient` | **one** | (`patient.updated` on both) | result | S | — |
| `POST /patients/summaries` | ≤ 50 IDs → minimum-necessary summaries; missing, foreign or unassigned IDs left out (D54) | R | read | — | R/phi-read, `body:/patientIds` (every ID returned) | — | — |

### 2.2 Scheduling (`scheduling`): 15 operations

| Operation | Service | Tables (W / R) | Tx | Events | Audit | Idem. | ETag |
|---|---|---|---|---|---|---|---|
| `GET /booking/facilities`, `/locations`, `/providers`, `/appointment-types` | through Anand's practice-setup service: active, bookable fields only (D49) | R (Anand's) | read | — | none | — | — |
| `GET /slots` | `slots.free_times(facility, provider, type, date)`: rules − exceptions − booked, in the facility's zone; a facility the user isn't assigned to → `404` | R schedules (through Anand's service), `appointment`, `appointment_participant` | read | — | none | — | — |
| `GET /appointments` | `date` or `dateFrom`–`dateTo` (≤ 31 days, D62); facility filter or the user's facilities | R `appointment`, `appointment_participant`, `appointment_reason`, `visit_flow_event` | read | — | result | — | — |
| `GET /appointments/{id}` | with visit status (`db/CLAUDE.md` rule after an undo) | R as above | read | — | result | — | ETag |
| `POST /appointments` | `book(body)`: patient active and not merged (patients service); provider and location belong to the facility; `pg_advisory_xact_lock` on (provider, local day) **plus** the exclusion constraint `ex_appointment_participant_no_double_booking` → `409 booking-conflict`; overbook only if the type allows it; queues eligibility (D15) | W `appointment`, `appointment_participant`, `appointment_reason`; `eligibility_check` (pending) through eligibility | **one** | `appointment.booked` | C/phi-write, `body:/patientId` | S | ETag + `Location` |
| `PATCH /appointments/{id}` | room, reason for visit, staff note, instructions only (D61) | W `appointment` | one | — | U/phi-write | — | If-Match |
| `POST …/cancel` | reason required; `left-without-being-seen` also cancels the encounter (§5.1) | W `appointment` (+ encounter through encounters) | one | `appointment.cancelled` | E/phi-write | — | ETag |
| `POST …/reschedule` | old → `cancelled` with the reason, new `booked` under the booking rules, `rescheduledFromId`; `durationMinutes` defaults to the new type's length when the type changes (#68 debt) | W 2 × `appointment` + participants | **one** | `appointment.rescheduled` | E/phi-write | S | new ETag + `Location` |
| `POST …/check-in` | `check_in(id, selfPay)`: same day in the facility's zone; booked/arrived → `checked-in`; **encounter created by `encounters.open_for_check_in` (status `arrived`)**; visit step; eligibility for the primary coverage unless self-pay (`422` with no active coverage and no `selfPay`) | W `appointment`, `encounter` (+ participant, location), `visit_flow_event`, `encounter.ext_self_pay` (#74), `eligibility_check` + outbox row | **one** (ADR-0011, D16) | `appointment.checked-in` | E/phi-write | **R** | `CheckInResult` |
| `POST …/undo-check-in` | before rooming and before any clinical data (D55): appointment → `booked`; encounter → `entered-in-error` with its Provenance (encounters service); the eligibility check is kept | W `appointment`, `encounter`, `provenance`, `provenance_agent` | **one** | `appointment.status-changed`, `encounter.entered-in-error` | E/phi-write | — | ETag |
| `POST …/status` | `arrived`, `roomed`, `with-provider`, `checked-out`, `noshow`, with the §5.1 guards; `checked-out` → `fulfilled` | W `appointment`, `visit_flow_event` (+ encounter status through encounters) | one | `appointment.status-changed`, `appointment.checked-out`, `encounter.status-changed` | E/phi-write | — | ETag |
| `GET /status-board` | staff view, or the shared view for `DSP` (initials, time, status; D47); restricted patients without a grant lose `reasonForVisit` (D60) | R appointments, encounters, visit flow | read | — | result (staff view) | — | — |

### 2.3 Eligibility (`eligibility`): 3 operations, plus the service used by booking, check-in and the batch

| Operation | Service | Tables (W / R) | Tx | Events | Audit | Idem. | ETag |
|---|---|---|---|---|---|---|---|
| `POST /eligibility-checks` | `queue_check(trigger="manual")`: coverage and appointment in this clinic; `pending` row + `enqueue(db, "clearinghouse", "270", …)` + operation `eligibility.check` | W `eligibility_check`, the outbox row, `operation` | **one** | (`operation.completed` later) | C/phi-write | **R** | `202` + Operation |
| `GET /eligibility-checks/{id}` | the single-column status mapping in `db/CLAUDE.md` | R `eligibility_check`, `eligibility_service_type`, `eligibility_benefit` | read | — | result | — | ETag |
| `GET /appointments/{id}/eligibility-checks` | booking, batch and check-in checks (D15) | R as above | read | — | result | — | — |
| *(service)* `record_response(db, check_id, parsed_271)` | called by Thulasi's webhook handler: `pending` → `complete`/`error`, benefits stored | W `eligibility_check`, `eligibility_benefit`, `eligibility_service_type` | one | `eligibility.completed` | (the webhook's own audit, actor partner) | dedupe by partner message ID | — |
| *(job)* pre-visit batch | next-day appointments, run nightly (D15) | as `queue_check` | one per check | — | system actor | key per check | — |

## 3. Dependencies

| PR | Needs merged first | Today (2026-10-27) |
|---|---|---|
| **PR-0** module skeletons, the routes↔contract conformance test, test fixtures | nothing | ✅ can start |
| **PR-1** patients core: search, register, get, PATCH, summaries, identifiers, related persons, restrict and unrestrict | #52 → #69 → #74 (MRN, D39 columns, employer); mapping (m); **core:** audit writer, break-glass helper, facility helper, idempotency, `publish()` | ❌ #52 waits on the `shri_maintenance` role; #69 is approved and waits on #52; #74 has changes requested; (m) isn't done (191 unmapped); no core pieces yet |
| **PR-2** coverages and consents (card images and the preferred pharmacy follow in PR-7) | PR-1; Anand's payer service | ❌ |
| **PR-3** scheduling reads: booking lists, slots, appointments, status board | PR-0; Anand's practice-setup read service; #74 (facility time zone NOT NULL); core facility helper | ❌ |
| **PR-4** booking writes: book, PATCH, cancel, reschedule, status | PR-3, PR-1 (patient check); `publish()` | ❌ |
| **PR-5** check-in and undo, with the encounter service | PR-4; #74 (`selfPay`); eligibility row (PR-6a) | ❌ |
| **PR-6a** eligibility rows and reads (no partner call) | #52 (operations) | ❌ |
| **PR-6b** eligibility through the clearinghouse | outbox (T29), Thulasi's 271 webhook handler, clearinghouse test account (Q11) | ❌ |
| **PR-7** card images and preferred pharmacy | Anand's file service; Thulasi's pharmacy service | ❌ |
| **PR-8** duplicates, merge, dismiss, undo, merge list | PR-1; #45 follow-up (c) (`UndoMergeRequest.reason`); the portal-account suspend rule (#67) | ❌ |

**Until the real login lands:** everything runs with the development login (`AUTH_MODE=dev_header`, development and test only). Endpoint code doesn't change when the real login arrives (`core/deps.py`).

**Decided (§7.1):** patient-data endpoints merge only after core's audit writing and restricted-chart check exist (audit fails closed, T17). They are built and tested now, on branches, against the interfaces in §6.

## 4. Testing

1. **Per endpoint, in each module's `tests/`, against a live PostgreSQL** (`TEST_DATABASE_URL`, as in CI):
   - success;
   - permission denied (`X-Dev-User: none`, plus a role without the permission, such as MA booking);
   - validation error;
   - `404` for another clinic's ID (`md-b`, clinic B: tenant isolation);
   - `404` for an unassigned `facilityId`;
   - `403 break-glass-required` on a restricted chart, and success with a grant or care-team membership;
   - `412`/`428` on every If-Match operation;
   - replay of a keyed POST.

   Synthetic data only, built with fixtures in each module's `tests/conftest.py`; no patient data anywhere.
2. **Routes ↔ contract conformance** (PR-0, no new dependency): every route in my modules matches one contract operation by method, path and `operationId`, its `require()` names the contract's `x-permission`, and every batch 1 operation has a route. This runs in the normal pytest job.
3. **Contract tests with Schemathesis** (TOOLCHAIN; CONTRACT_GOVERNANCE §6, layers 2 and 5):
   - run against the real API with the development login, per tag (`patients`, `scheduling`, `eligibility`), including examples mode and stateful runs through the contract's links;
   - **Needs Thulasi:** Schemathesis 4.32.3 (MIT; released 2026-10-21, so the 7-day rule allows it from 2026-10-28) added to `backend/pyproject.toml` and both hashed locks, and a `contract-tests` job in CI. Both files are hers (CODEOWNERS default), so this is a note, not my edit.
4. **The front-desk flow** (the mock flow from batch 1) moved into `contracts/tests/flows/front-desk.mjs` with a base URL and auth header. It runs against Prism (as today) and, from PR-5 on, against the real API with seeded synthetic data:
   - search, register (and the duplicate `409`), coverage, book, check in, status board, undo check-in, reschedule, cancel;
   - against the real API it checks the state after each step, not just the codes.
5. `ruff`, `mypy` (strict), and `alembic check` untouched: I add no migrations.

## 5. PR order (small, patients first so Minalini can switch her screens)

1. **PR-0:** skeletons for `patients`, `scheduling`, `eligibility` and `encounters`; schemas generated for batch 1; the conformance test (expected failures listed until each route lands); fixtures; the front-desk flow script. Reviewer: Thulasi (CODEOWNERS default on shared paths, if any).
2. **PR-1:** patients core (search, register, get, PATCH, summaries, identifiers, related persons, restrict). **Minalini's registration and patient screens switch here.**
3. **PR-2:** coverages and consents. **The insurance screens switch.**
4. **PR-3:** scheduling reads. **The schedule views switch.**
5. **PR-4:** booking writes.
6. **PR-5:** check-in and undo (with the encounter service). **The front-desk flow runs end to end against the real API.**
7. **PR-6a, then PR-6b:** eligibility, rows first, then the partner.
8. **PR-7:** card images and preferred pharmacy.
9. **PR-8:** duplicates and merges (admin portal, D64).

Each PR is a few hundred lines with its tests, and asks Minalini for a review where her screens switch.

## 6. Notes for the owners

### For Thulasi (core): interfaces I'd build against. Your design; these are proposals
- **Audit from `x-audit`:** every route sets `operation_id` to the contract's `operationId`, so core can look up `x-audit`, `x-idempotency` and `x-permission` per operation. I can generate an `operations.json` from the bundle into `contracts/openapi/dist/` for core to read. Endpoints name the patient when it isn't in the path through `audit_patients(request, ids)`.
- **Break-glass:** `await ensure_chart_access(db, user, patient_id)`, which raises `break-glass-required` and handles grants, the care team (D37) and the allowed front-desk exceptions (§5.2 rule 2).
- **Facility scope:** `facility_filter(user, column)` and `require_facility(user, facility_id)` (`404`).
- **Idempotency** (ADR-0007, T21) on `admin.idempotency_record`; **`publish(db, type, subject, data)`** into `admin.event_log` in the same transaction; **`create_operation(db, kind, …)`** for `202`; the cursor helpers (T22); the outbox `enqueue` (T29).
- **Schemathesis** in `backend/pyproject.toml` and both locks, and a `contract-tests` CI job (§4.3).
- **A pharmacy read service:** `get_pharmacy(db, id)` for `preferredPharmacy` (D50).

### For Anand
- **Mapping (m):** before PR-1 merges.
- **#74.**
- **Read services I'd call instead of your tables:**
  - practice setup: `bookable_facilities/locations/providers/appointment_types(db, user)` and `schedule_for(db, provider, facility, day)`;
  - payers: `get_payer(db, id)`;
  - files: `attach(db, file_id, purpose)`.
- **The FHIR write helpers** (`create/update/entered_in_error` with Provenance and version checks): the interface I code against is posted on issue #13 (§7.3).
- **(c)** `UndoMergeRequest.reason`.

### For Minalini
- Which screens switch with which PR (§5).
- The front-desk flow script, for her checks.

## 7. Decisions (Vimal, 2026-10-27)

1. **No endpoint merges without audit.** Patient-data endpoints merge only after core's audit writing and restricted-chart check exist. They are built and tested now, on branches.
2. **Patients are practice-wide.** Search and registration cover any patient in the clinic. Facility limits apply to appointments and work lists only.
3. **FHIR write helpers:** the exact interface (function names, inputs, outputs) for Patient and its child rows, Coverage, Consent and RelatedPerson is posted on issue #13 for Anand to build. My repositories are coded against it now.

## 8. The demo on 20 November (revision 2)

**Goal:** on 20 November, one complete patient visit runs on the real system, end to end, across the patient, front-desk and clinician portals.
- Synthetic patients only.
- The payer (eligibility) and the pharmacy are simulated.
- No AI.

**The calendar:**
| Date | What |
|---|---|
| Wed 28 Oct | Pre-registration contract ready for review |
| 31 Oct | Check-out (follow-up and copay) and prescriptions-slice contracts ready for review |
| **Tue 3 Nov** | Checkpoint 1, with cut decisions (D102) |
| 7 Nov | Payer and pharmacy message shapes |
| **Tue 10 Nov** | Checkpoint 2, with cut decisions (D102); laptop fallback decided |
| **Tue 17 Nov** | Checkpoint 3 |
| Wed 18, Thu 19 Nov | Rehearsals |
| **Fri 20 Nov** | Demo |

The cut order (§8.6) says what is dropped first if a checkpoint slips.

### 8.1 The story, step by step: what the contract has, and what is missing

"Have" means the operation is in the contract on `main`, or in an open contracts PR: #73 (portal B8a), #80 (back-channel logout and the operations read). "Missing" items are drafted as contract changes in §8.2.

| # | Step | Contract operations it uses (have) | Missing |
|---|---|---|---|
| 1 | **Patient pre-registers online** | — | **All of it** (§8.2 A): a public submission, a staff queue, accept and reject |
| 2 | **Front desk verifies and creates the patient**: automatic MRN, duplicate check | `POST /patients/search`; `POST /patients` (MRN from `next_mrn()`, D41; `409 possible-duplicate`); `GET`/`PATCH /patients/{patientId}` | Accepting a pre-registration creates the patient through the same rules (§8.2 A) |
| 3 | **Insurance and simulated eligibility** | `POST /patients/{patientId}/coverages`; `POST /eligibility-checks` (`202`); `GET /eligibility-checks/{id}`; `GET /operations/{operationId}` (#80) | Nothing in the contract. Needs the outbox and the simulated payer (Thulasi) |
| 4 | **Booking** | `GET /booking/*`, `GET /slots`, `POST /appointments` | — |
| 5 | **Portal invitation code** | `POST /patients/{patientId}/portal-invitations`, `GET …/portal-account` (#73) | — |
| 6 | **Check-in and the status board** | `POST /appointments/{appointmentId}/check-in` (the encounter in the same transaction); `GET /status-board`; `GET /events/stream` for the live board | Nothing in the contract. The live board needs core's `publish()` and the event stream (Thulasi) |
| 7 | **MA rooming**: vitals, allergies, current medications, reason for visit | `POST /appointments/{id}/status` (`roomed`); `POST /encounters/{id}/vitals`; `GET`/`POST /patients/{id}/allergies`; `PATCH /appointments/{id}` (reason for visit) | **Current medications:** `GET`/`POST /patients/{patientId}/medications` (#116–117), in the prescriptions slice (§8.2 B) |
| 8 | **Doctor consultation**: history, diagnoses, templated note, signing | `GET /encounters/{id}`; history (problems, allergies, family, social, surgical); `POST /encounters/{id}/diagnoses`; `GET /codes`; `GET /note-templates`; `POST /encounters/{id}/notes`; `PATCH /notes/{id}`; `POST /notes/{id}/sign` | **A permission fix:** `GET /note-templates` still says `practice-setup:read`, but clinicians read templates through `note-templates:read` (D73, T42, already in core). §8.2 D |
| 9 | **Prescription**: drug search, allergy and duplicate alerts, sign, send to a simulated pharmacy, medication list | `GET /codes?system=rxnorm` (code search; D73 renamed `/codes/search` to `GET /codes`); `GET /pharmacies` | **The prescriptions slice** (§8.2 B): drafts, safety check, override, sign-and-send through the outbox, transmission statuses, the medication list |
| 10 | **Follow-up request** | — | **A follow-up request on the visit** (§8.2 C) |
| 11 | **Check-out**: copay, after-visit summary, revisit booked | `POST /appointments/{id}/status` (`checked-out` → `fulfilled`); `POST /encounters/{id}/close`; `POST /patients/{patientId}/payments` and `POST /payments/card-session` (copay, batch 1, x-owner Anand); `POST /encounters/{id}/after-visit-summary` (`202`) with `GET /operations/{id}` (#80); `POST /appointments` (the revisit) | **The follow-up shown at check-out,** and the revisit marking it booked (§8.2 C) |
| 12 | **The patient signs in to the portal** and sees the revisit, the visit summary and the prescription | `GET /portal/auth/login`, `/callback`; `GET /portal/me/appointments`; `GET /portal/me/visit-summaries` and `…/download-url` (#73) | **The prescription:** `GET /portal/me/medications` (§8.2 E). Sign-in needs the patient realm and core's portal session (Thulasi) |

### 8.2 Draft contract changes (prose; the YAML follows once this plan is approved)

These go in four contracts PRs, contract first (root `CLAUDE.md`), each ready for review with all three reviewers requested: **A** (pre-registration) by **Wednesday 28 October**; **C** (check-out with the follow-up request and copay) and **B** (the prescriptions slice) by **31 October**; then **D** and **E** together (note templates for clinicians, the portal's medication list).

**A. Pre-registration** (new; x-owner Vimal, patients module)
- **Public submission, `POST /portal/pre-registrations`:**
  - **No account and no session:** `x-permission: public`, added to the public allowlist.
  - **What it takes:**
    - name, date of birth, sex, phones, email, address and preferred language;
    - the optional D39 fields;
    - insurance as typed (payer name, member ID, group);
    - the preferred facility and the reason for the visit;
    - consent to be contacted, which is required.
  - **What it answers:** always the same generic success, `204` with no body, whether or not the person is already a patient, so the form can't be used to learn who is a patient here. Only a malformed request, a failed bot check or a rate limit gets a different answer, and those say nothing about the person.
- **Abuse protection:**
  - `Origin` must be the portal host, as for enrollment (ADR-0013 §5);
  - rate limits per IP and per email address (core and Nginx);
  - an **open-source bot check, ALTCHA** (MIT, proof-of-work, self-hosted, no third party; allowed under D75). The server verifies its token, and nothing about the visitor goes to anyone else. An alternative is Cap (Apache-2.0).
  - ALTCHA is added only after it passes the **7-day rule** and the **licence check** (D75), through the lockfile rule (`CLAUDE.md`).
- **The staff queue** (FD, ADM; new permissions `pre-registrations:read`, `:accept`, `:reject`):
  - `GET /pre-registrations`: `status` (`pending`, `accepted`, `rejected`) and `facilityId` filters, oldest first;
  - `GET /pre-registrations/{preRegistrationId}`.
- **Accept, `POST /pre-registrations/{id}/accept`:**
  - It either creates the patient through the registration rules (duplicate check with `409 possible-duplicate` and the override, MRN from `next_mrn()`), or links to an existing `patientId` chosen after duplicate review. Insurance becomes a coverage.
  - It links the request to the patient, all in one transaction.
  - Fields from the request are marked patient-reported (`entry_source`, FR-PAT-02) until the front desk verifies them against ID at the visit.
- **Reject, `POST /pre-registrations/{id}/reject`:** `reasonCode` is `duplicate`, `incomplete`, `not-our-practice`, `spam` or `other`, with `reasonText` required for `other`.
- **Storage:** submissions are stored encrypted at rest, like other patient data (D30).
- **Retention:** rejected requests, and requests never reviewed, are **deleted after 30 days**; an accepted request is kept as the patient record's source. Nothing is ever emailed or texted back with patient data (D81).
- **Audit:**
  - The submission is audited with a new `x-audit.actor` value, `anonymous` (no user and no patient session; EXTENSIONS and the `shri-x-audit` rule), category `phi-write`.
  - Accept and reject are audited as `phi-write` with the patient once linked; a reject is audited as `security` when its reason is `spam`.
- **A decision row** records: no account, the bot check, the 30-day retention, and patient-reported until verified.

**B. The prescriptions slice** (inventory B5, demo subset; x-owner Thulasi). **Built by Vimal with Thulasi reviewing if she agrees; otherwise the work moves to her.**
- **The medication list:** `GET`/`POST /patients/{patientId}/medications` (#116–117). The list is `MedicationRequest` with `intent` and `reported[x]` (D28); rooming records the current medications here.
- **Drafts:**
  - `POST /prescriptions` (#120), then `GET`/`PATCH /prescriptions/{prescriptionId}` (#121–122) with `If-Match`;
  - `POST …/entered-in-error` for a wrong draft (#227).
- **Drug search:** `GET /codes?system=rxnorm&q=`, limited to the free **RxNorm Current Prescribable Content** subset, which needs no UMLS licence. Anand loads it (§8.4).
- **Safety check, `POST /prescriptions/{id}/safety-check` (#123):**
  - an **allergy alert:** an active allergy coded to an RxNorm ingredient of the drug;
  - a **duplicate-medication alert:** an active medication with the same ingredient.
  - The alerts are **fixed rules in code, each with its tests; never AI** (D99).
  - Each alert has a severity. `POST /alerts/{alertId}/override` (#124) takes a required reason where the severity requires one, and is audited.
  - The drug-interaction database (Q13) isn't in the demo; the contract leaves room for its alert kind.
- **Sign and send, `POST /prescriptions/{id}/sign-and-send` (#125):**
  - `If-Match` and an `Idempotency-Key`;
  - refused while an alert that needs an override has none;
  - signs and locks the prescription, writes its Provenance, and queues NewRx through the outbox (`enqueue(db, "erx", "NewRx", …)`, D25) in one transaction. Sending always goes through the outbox to the simulated pharmacy (D99), never straight from the request.
- **Transmission:** `queued` → `sent` → `accepted` or `rejected`, through `/hooks/erx` (#21) from the simulated pharmacy. Each change publishes `prescription.transmission-updated`.
- **Discontinue (#118)** is in only if time allows; cancel and change (#126–127), refills (#128–129) and the outside medication history (#131) are after the demo.

**C. Follow-up request and check-out** (x-owner Vimal: encounters and scheduling)
- **`PUT /encounters/{encounterId}/follow-up`** (MD, APP; `encounters:update`; `If-Match` on the encounter):
  - it takes `{ interval: { value, unit: day | week | month }, appointmentTypeId?, providerId?, note? }`, stored as the visit's follow-up request with status `open`;
  - the encounter's response carries it.
- **At check-out:** `GET /appointments/{appointmentId}` and the status board's staff view carry a **minimum `followUp` summary** (interval, type, provider, status), so the front desk sees it without `encounters:read`.
- **Booking the revisit:** `POST /appointments` takes an optional `followUpOfEncounterId`, which marks the request `booked` and links the new appointment, in the same transaction.
- **When the patient doesn't book:** `POST /encounters/{encounterId}/follow-up/decline` (FD; `appointments:status`) with a reason.
- **Check-out** stays `POST /appointments/{id}/status` with `checked-out`, which completes the visit flow (`fulfilled`, `appointment.checked-out`). The encounter closes through `POST /encounters/{id}/close` once the note is signed (Q22 guards).
- **The copay** is the batch 1 payment operations: amount due from the eligibility check's copay, card through the processor's hosted fields (here, a simulation). **Recording the copay is Anand's** (D100): he builds the payment service behind `POST /patients/{patientId}/payments` and `POST /payments/card-session` (x-owner Anand); check-out calls those operations and adds none of its own.

**D. Note templates for clinicians:** `GET /note-templates` and `GET /note-templates/{noteTemplateId}` change from `practice-setup:read` to `note-templates:read` (D73, T42). It's a permission fix with x-owner Anand, and needs his agreement.

**E. The portal's medication list:** `GET /portal/me/medications`, an addition to B8a:
- active and recent medications, including a new prescription with its transmission status, and no prescriber-only notes;
- `portal-records:read`, audited `phi-read` with `patient: session`;
- x-owner Thulasi (medications, D83).

### 8.3 My implementation order to 20 November

The PRs are small, each with its tests (§4), and the routes-to-contract test is updated as each lands.

**Merge rule:** every patient-data PR merges only when core's audit writing and restricted-chart check exist (§7.1). Until then it is built and tested on a branch. The checkpoint is the date the PR is **ready to merge**. At the 3 and 10 November checkpoints we decide what to cut (§8.6, D102).

| Checkpoint | PR | Content | Needs first |
|---|---|---|---|
| **Wed 28 Oct** | Contracts A: pre-registration | §8.2 A | #73 merged (done) |
| 31 Oct | Contracts C: check-out | §8.2 C, with the copay through Anand's payment operations | — |
| 31 Oct | Contracts B: prescriptions slice | §8.2 B | — |
| After B | Contracts D and E | Note templates for clinicians (Anand's agreement, x-owner); the portal's medication list. Then the debts from #68, #58 and #64 (follow-up 3, #80) | — |
| 7 Nov | Payer and pharmacy message shapes | The 270/271 and NewRx/status payloads the outbox sends to Thulasi's simulated payer and pharmacy | Contracts B |
| **Tue 3 Nov** | PR-1 patients core | Search, register (MRN, duplicates), read, edit, summaries, identifiers, related persons, restrict | #52 → #69 → #74; mapping (m); write helpers; core's four pieces |
| 3 Nov | PR-2 coverages and consents | Insurance and consents (card images later) | PR-1; Anand's payer service |
| 3 Nov | PR-P pre-registration | Public submission (bot check, `Origin`, rate limits), staff queue, accept (through `register`) and reject, retention | PR-1; the pre-registration table; the bot-check dependency through the lockfile |
| **Tue 10 Nov** | PR-3, PR-4 scheduling | Booking lists, slots, appointments, status board; book, edit, cancel, reschedule, status | Anand's practice-setup reads; core's facility filter |
| 10 Nov | PR-5 check-in, rooming and check-out | Check-in and undo with the encounter service; rooming (`roomed`, vitals, allergies, reason for visit); check-out (`checked-out`, the follow-up shown); the follow-up request (§8.2 C) | PR-4; write helpers for encounters and vitals |
| 10 Nov | PR-6a eligibility | Check rows and reads, tested against recorded payer replies; end to end once the simulated payer lands (17 Nov) | Core's outbox and operations; the payer message shape (7 Nov) |
| **Tue 17 Nov** | PR-9 notes and signing | Encounter workspace, diagnoses, history, templated notes, signing with Provenance, after-visit summary (`202`) | Write helpers for notes, diagnoses and Provenance; note templates (§8.2 D) |
| 17 Nov | PR-10 prescriptions | §8.2 B in `modules/medications`, with Thulasi reviewing if she agrees (otherwise hers) | The RxNorm load; write helpers for prescriptions; the outbox; the simulated pharmacy |
| 17 Nov | PR-11 portal reads | Portal appointments, visit summaries and medications (§8.2 E); staff portal invitations and account | Core's portal session and `PAT`, or the patient development sign-in |
| Wed 18, Thu 19 Nov | Rehearsals | The full story on the test server, twice, with the demo reset between runs; fixes only | Everything above |

Card images (PR-7), duplicates and merges (PR-8) and the manual eligibility run aren't in the story, so they come after the demo.

### 8.4 What each person delivers, and when (confirmed on #85)

**Anand**
| By | What |
|---|---|
| **Tue 3 Nov** | #52, #69, #74 and the A43 PR merged; mapping (m) for patients and the write helpers (patients, coverage, consent, related persons); the pre-registration table |
| Thu 5 Nov | Visit helpers: encounters, vitals, diagnoses |
| Fri 6 Nov | The portal tables |
| Mon 9 Nov | **Demo setup data** (one synthetic practice: facilities, providers, schedules, appointment types, payers, a pharmacy, note templates); the practice-setup read services; the **RxNorm Current Prescribable Content** load (its licence recorded under D75) |
| Wed 11 Nov | Prescription helpers (`MedicationRequest`) and note helpers (Composition, Provenance) |
| Fri 13 Nov | **The one-command demo reset script:** back to the demo setup data, synthetic patients only |
| Date to confirm | The 30-day purge of rejected and never-reviewed pre-registrations (§8.2 A), with the table's retention; needed by 3 Nov with PR-P |
| Date to confirm | **The copay recording service** (D100): the payment operations with the simulated card processor. Check-out needs it by the 10 November checkpoint |

**Thulasi**
| By | What |
|---|---|
| **Tue 3 Nov** | The four core pieces: audit from `x-audit` (#79), the restricted-chart check, the facility filter, idempotency |
| **Tue 10 Nov** | **Real staff sign-in** (Keycloak realm #72, core's login and session) and **demo accounts** for each role (FD, MA, MD, ADM, and the patient) |
| **Tue 17 Nov** | **The simulated payer** (270 in, 271 back through the webhook) and **the simulated pharmacy** (NewRx in, status back through `/hooks/erx`); **the patient session** (patient realm, core's portal session, `PAT` permissions; ADR-0013, T45) |
| Test server | One cloud server running our Docker setup. Whether to fall back to a laptop is decided by **Tue 10 Nov** |

**Not yet in Thulasi's reply** (asked on #85; each is needed by the date shown):
- a development sign-in for patients (`PAT`), like `X-Dev-User`, for building the portal steps before 17 Nov;
- `publish()` and the event stream (the live status board), by 10 Nov;
- `create_operation` and the operations read (#80), by 10 Nov (eligibility, the after-visit summary);
- the outbox `enqueue` (T29), by 10 Nov (eligibility; prescriptions by 17 Nov);
- her review of the prescriptions slice (§8.2 B, x-owner Thulasi).

**Minalini:** the screens **in demo order** (§8.1), each built on the mock as its contract lands (pre-registration from 28 Oct, check-out and prescriptions from 31 Oct), then switched to the real services as each PR merges at the checkpoints.

**Vimal**
| By | What |
|---|---|
| Wed 28 Oct | The pre-registration contract (§8.2 A) |
| 31 Oct | The check-out and follow-up contract (§8.2 C) and the prescriptions slice (§8.2 B) |
| 7 Nov | The payer and pharmacy message shapes |
| Tue 3, 10, 17 Nov | The services in §8.3, ready to merge at each checkpoint |

**Staff accounts for the demo:** disabling a staff member is done in Keycloak's admin console; there is no new screen (D101).

### 8.5 Risks
- **Everything rests on the chain #52 → #69 → #74 and the write helpers.** If the helpers slip past 3 November, I'll write the rows in my repositories against the §7.3 interface and swap in the helpers later.
- **The prescriptions slice sits in Thulasi's module.** Without her agreement it moves to her, and its PR-10 date becomes hers.
- **Practice-setup reads land on 9 November,** the day before the scheduling checkpoint; scheduling is built against test data until then.
- **The simulated payer lands on 17 November,** a week after the eligibility PR; PR-6a is tested against recorded replies and runs end to end only from 17 November.
- **Real sign-in for staff and patients** is the most likely to slip. The development sign-ins are the fallback for rehearsal, not for the demo itself.

### 8.6 Cut order (agreed)
Cut decisions are made at the **3 and 10 November checkpoints** (D102), not later. If a checkpoint slips, cut in this order, and the story still runs:
1. **Portal sign-in.** The portal step uses the patient development sign-in on the test server.
2. **Pre-registration.** The front desk registers the patient directly at step 2.
3. **Copay.** Check-out records no payment.
4. **The live status board.** The board refreshes instead of updating live.
