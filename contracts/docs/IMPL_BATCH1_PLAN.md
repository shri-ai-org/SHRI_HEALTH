# Batch 1 implementation plan: patients, scheduling, eligibility (Stage A)

Owner: Vimal (drafted with Claude Code) · 2026-10-27 · Branch `vimal/impl-batch1` from `main` (`dd36d41`) · **Approved by Vimal on 2026-10-27, with the decisions in §7.**

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
