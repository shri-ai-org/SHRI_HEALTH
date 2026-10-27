# Endpoint inventory and traceability

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** each module owner for their rows (VD-SIGN): Thulasi (platform, medications, orders), Anand (files, practice setup, billing, documents, C-CDA, inbox, exports), Minalini (communications, dashboard), Vimal (Vimal's modules and standards conformance of all rows). **Thulasi signed off rows #1–27 and #116–147 on issue #3 (2026-10-22) with the changes applied below; Minalini's rows #220–226 are pending her review (M16).**

This is the checklist for Stage 4: an endpoint is "done" when its contract exists with every field below. Source: CAT, changed only where a decision says so (last column). P1 endpoints and `/fhir` are excluded (VD-SCOPE).

## Column key

| Column | Meaning |
|---|---|
| Path | Under `/api/v1` unless marked `(root)`. Path parameters renamed to `{<resource>Id}` (API_STANDARDS §3) |
| Owner | `x-owner`: **V** Vimal, **T** Thulasi, **A** Anand, **M** Minalini |
| Store | DATA_OWNERSHIP §1 (one PostgreSQL, ADR-0011): Cl clinical (FHIR-shaped), Ad admin (normalized), Au audit, F files, C computed. Exact tables come from the locked schema (D72; changes by migration) |
| Permission | `x-permission` (SECURITY_MODEL §4) |
| Audit | `x-audit` category: pr = phi-read, pw = phi-write, sg = sign, ex = export, sec = security, ai, adm = admin, – = none |
| Idem | `Idempotency-Key`: **R** required, S supported, – not applicable |
| IfM | `If-Match` required (API_STANDARDS §11) |
| 202 | Returns `202` + operation (API_STANDARDS §13) |
| FRS | Requirement traced (FRS section or requirement ID) |
| B | Stage 4 batch (below) |
| Change | Difference from CAT, with the decision that caused it |

## Stage 4 batches (D6: contracts first; admin and front-desk before clinical; VG §2)

| Batch | Content | Why this order |
|---|---|---|
| B1 | Shared components, platform (auth, me, users, roles, operations, events), files, practice setup | Everything else references these |
| B2 | Patients and insurance | VG Day 1 item 2 (admin first); Minalini starts wiring |
| B3 | Scheduling, check-in, eligibility, payments, front-desk documents and fax, communications, inbox | Front desk before clinical (D6) |
| B4 | Encounters, notes, co-signature rules, history | Clinical (Vimal) |
| B5 | Medications, prescriptions, orders, results | Clinical (Thulasi) |
| B6 | Billing and claims, C-CDA, exports, audit and integration admin, dashboard | Back office |
| B7 | AI | After Step 5 endpoints (VD-G11) |
| B8 | Patient portal (P1): **B8a** sign-in, enrollment, profile, appointments and booking, visit summaries, problems, allergies, vitals; **B8b** messages, results, prescriptions, documents, forms, bills, exports | B8a reads only what B2–B4 already specify; B8b follows B3, B5 and B6 (D88, D89) |

---

## 1. Platform — Thulasi (signed off, issue #3)

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/auth/login` | T | – | `public` | sec | – | | | §6 Security | B1 | **Contract written in the batch 1 follow-up** (2026-10-24, D52): 302 to Keycloak; audited as `security` like the callback |
| 2 | GET | `/auth/callback` | T | Ad | `public` | sec | – | | | §6 | B1 | **Contract written in the batch 1 follow-up** (2026-10-24, D52) |
| 3 | POST | `/auth/refresh` | T | Ad | `authenticated` | sec | – | | | §6 | B1 | **Contract written in the batch 1 follow-up** (2026-10-24, D52): returns `Session` |
| 4 | POST | `/auth/logout` | T | Ad | `authenticated` | sec | – | | | §6 | B1 | Returns 204 (API_STANDARDS §4). **Contract written in the batch 1 follow-up** (2026-10-24, D52) |
| 5 | GET | `/auth/session` | T | Ad | `authenticated` | – | – | | | §6 | B1 | Returns `{ user, organization, csrfToken, idleExpiresAt, expiresAt }`: the CSRF token, the idle expiry the screen times its 13-minute warning from, and the absolute (12-hour, not extendable) expiry (SECURITY_MODEL §2.1, §2.2; Thulasi T8, issue #3). **Contract written in the batch 1 follow-up** (2026-10-24, D52) |
| 6 | GET | `/me` | T | Ad | `authenticated` | – | – | | | §3.10 | B1 | **Contract written in the batch 1 follow-up** (2026-10-24, D52): user, organization, effective permissions |
| 7 | GET | `/users` | T | Ad | `users:read` | adm | – | | | §3.10 | B1 | |
| 8 | POST | `/users` | T | Ad | `users:create` | adm | S | | | §3.10 | B1 | |
| 9 | GET | `/users/{userId}` | T | Ad | `users:read` | adm | – | | | §3.10 | B1 | |
| 10 | PATCH | `/users/{userId}` | T | Ad | `users:update` | adm | – | ✓ | | §3.10 | B1 | |
| 11 | GET | `/roles` | T | Ad | `roles:read` | – | – | | | §3.10 | B1 | |
| 12 | GET | `/users/{userId}/roles` | T | Ad | `roles:read` | adm | – | | | §3.10 | B1 | |
| 13 | PUT | `/users/{userId}/roles` | T | Ad | `user-roles:update` | sec | – | ✓ | | §3.10 | B1 | |
| 14 | GET | `/events/stream` | T | – | `authenticated` | – | – | | | FR-ORD-02, FR-SCH-02 | B1 | **Contract written in the batch 1 follow-up** (2026-10-24, D52): `text/event-stream`, `Last-Event-ID` resume (EVENTS.md §3) |
| 15 | GET | `/operations/{operationId}` | T | Ad | `authenticated` | – | – | | | — | B1 | **New** (API_STANDARDS §13); owner Thulasi (T26). Visible only to the creating user in the MVP; polling does not reset the idle timer. **Written** 2026-10-27 (#80, Minalini's ask on #70): `Retry-After` while unfinished |
| 16 | POST | `/operations/{operationId}/cancel` | T | Ad | `authenticated` | – | – | | | — | B1 | **New**. **Written** 2026-10-27 (#80): the creator only, where the kind allows it (AI kinds); `409` once finished |
| 17 | GET | `/audit-events` | T | Au | `audit-events:read` | sec | – | | | §3.10, §6 Audit | B6 | |
| 18 | GET | `/reports/chart-access` | T | Au | `chart-access-reports:read` | sec | – | | | §6 Sensitive records | B6 | |
| 19 | POST | `/patients/{patientId}/break-glass` | T | Au | `patients:break-glass` | sec | S | | | FR-PAT-01 | B1 | **Contract written in the batch 1 follow-up** (2026-10-24, D53): four reason codes, `reasonText` required for `other`, grant with `expiresAt` (4 hours) |
| 20 | POST | `/hooks/clearinghouse` (root) | T | Ad+F | `partner-signed` | pw (partner as actor, T37) | – | | | FR-RCM-01/02 | B6 | Outside `/api/v1`, public through Nginx (T24) |
| 21 | POST | `/hooks/erx` (root) | T | Ad+F | `partner-signed` | pw (partner as actor, T37) | – | | | FR-MED-01 | B5 | Same |
| 22 | POST | `/hooks/fax` (root) | T | Ad+F | `partner-signed` | pw (partner as actor, T37) | – | | | §3.9 | B3 | Same |
| 23 | POST | `/hooks/sms` (root) | T | Ad+F | `partner-signed` | pw (partner as actor, T37) | – | | | FR-SCH-01 reminders | B3 | Same |
| 292 | POST | `/hooks/keycloak/backchannel-logout` (root) | T | Ad | `partner-signed` | sec (partner as actor) | – | | | §6 sessions | B1 | **New** (D94, 2026-10-27): Keycloak's signed `logout_token` (OpenID Connect Back-Channel Logout 1.0); ends matching staff sessions at once; `200`, or `400` for any failure; only from Keycloak |
| 293 | POST | `/portal/pre-registrations` | V | Ad | `public` | pw (actor anonymous) | – | | | FR-PAT-01 | Demo | **New** (D96): the public form; always the same `204`; `Origin`, rate limits, ALTCHA; encrypted; deleted after 30 days unless accepted |
| 294 | GET | `/pre-registrations` | V | Ad | `pre-registrations:read` | pr | – | | | FR-PAT-01 | Demo | **New** (D96): the front desk's queue |
| 295 | GET | `/pre-registrations/{preRegistrationId}` | V | Ad | `pre-registrations:read` | pr | – | | | FR-PAT-01 | Demo | **New** (D96) |
| 296 | POST | `/pre-registrations/{preRegistrationId}/accept` | V | Cl+Ad | `pre-registrations:accept` | pw | S | | | FR-PAT-01 | Demo | **New** (D96): creates (duplicate check, MRN) or links the patient, one transaction |
| 297 | POST | `/pre-registrations/{preRegistrationId}/reject` | V | Ad | `pre-registrations:reject` | pw | – | | | FR-PAT-01 | Demo | **New** (D96): with a reason |
| 300 | GET | `/portal/me/medications` | T | Cl | `portal-records:read` | pr (patient session) | – | | | §3.8 | Demo | **New** (plan §8.2 E; written for the demo ahead of B8b, together with the staff medications contract in #93, D88): the patient's medication list, with transmission status |
| 24 | GET | `/admin/integration-messages` | T | Ad | `integration-messages:read` | adm | – | | | TA §7.1 | B6 | |
| 25 | POST | `/admin/integration-messages/{messageId}/replay` | T | Ad | `integration-messages:replay` | adm | S | | | TA §7.1 | B6 | |
| 26 | GET | `/health` (root) | T | – | `public` | – | – | | | §6 Availability | B1 | Outside `/api/v1`, public through Nginx (T24) |
| 27 | GET | ~~`/ready`~~ | T | – | — | – | – | | | §6 | — | **Not in the contract:** internal only (load balancer and Compose), T24 |

## 2. Patients and insurance — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 28 | POST | `/patients/search` | V | Cl | `patients:search` | pr | – | | | FR-PAT-01 | B2 | **Was `GET /patients?search=`** (VD-G2) |
| 29 | POST | `/patients` | V | Cl | `patients:create` | pw | S | | | FR-PAT-01 | B2 | Duplicate check → `409 possible-duplicate` |
| 30 | GET | `/patients/{patientId}` | V | Cl | `patients:read` | pr | – | | | FR-PAT-01 | B2 | |
| 31 | PATCH | `/patients/{patientId}` | V | Cl | `patients:update` | pw | – | ✓ | | FR-PAT-01 | B2 | |
| 32 | GET | `/patients/{patientId}/identifiers` | V | Cl | `patients:read` | pr | – | | | FR-PAT-01 | B2 | |
| 33 | POST | `/patients/{patientId}/identifiers` | V | Cl | `patients:update` | pw | S | | | FR-PAT-01 (license scan) | B2 | License image is a document (category `identity`), referenced by `documentId` (D56) |
| 34 | GET | `/patients/{patientId}/related-persons` | V | Cl | `patients:read` | pr | – | | | FR-PAT-01 (emergency contacts) | B2 | **New** (Stage 1 gap) |
| 35 | POST | `/patients/{patientId}/related-persons` | V | Cl | `patients:update` | pw | S | | | FR-PAT-01 | B2 | **New** |
| 36 | PATCH | `/patients/{patientId}/related-persons/{relatedPersonId}` | V | Cl | `patients:update` | pw | – | ✓ | | FR-PAT-01 | B2 | **New** |
| 257 | GET | `/patients/{patientId}/related-persons/{relatedPersonId}` | V | Cl | `patients:read` | pr | – | | | FR-PAT-01 | B2 | **New** (contracts follow-up 2, 2026-10-26; Minalini on #48): one related person with the strong `ETag` #36 needs |
| 37 | GET | `/patients/{patientId}/coverages` | V | Cl | `coverages:read` | pr | – | | | FR-PAT-01, FR-RCM-01 | B2 | |
| 38 | POST | `/patients/{patientId}/coverages` | V | Cl | `coverages:create` | pw | S | | | FR-RCM-01 | B2 | |
| 39 | PATCH | `/patients/{patientId}/coverages/{coverageId}` | V | Cl | `coverages:update` | pw | – | ✓ | | FR-RCM-01 | B2 | |
| 256 | GET | `/patients/{patientId}/coverages/{coverageId}` | V | Cl | `coverages:read` | pr | – | | | FR-RCM-01 | B2 | **New** (contracts follow-up 2, 2026-10-26; Minalini on #48): one coverage with the strong `ETag` #39 needs, so a coverage can be ended (D45) |
| 40 | POST | `/patients/{patientId}/coverages/{coverageId}/card-images` | V | Cl+F | `coverages:update` | pw | S | | | FR-PAT-01 | B2 | Body `{ fileId, side }` (API_STANDARDS §15) |
| 232 | POST | `/patients/{patientId}/coverages/{coverageId}/entered-in-error` | V | Cl | `coverages:entered-in-error` | pw | – | | | FR-PAT-01, FR-RCM-01 | B2 | **New** (D45, 2026-10-23): a coverage recorded by mistake; ending one is `PATCH` with `endDate` |
| 41 | GET | `/patients/{patientId}/consents` | V | Cl | `consents:read` | pr | – | | | FR-PAT-01 | B2 | |
| 42 | POST | `/patients/{patientId}/consents` | V | Cl | `consents:create` | pw | S | | | FR-PAT-01, AI-01 (recording consent) | B2 | |
| 43 | PUT | `/patients/{patientId}/preferred-pharmacy` | V | Ad | `patients:update` | pw | – | ✓ | | FR-PAT-01 | B2 | |
| 44 | POST | `/patients/{patientId}/restrict` | V | Cl | `patients:restrict` | sec | – | | | FR-PAT-01 | B2 | **New** (Stage 1 gap) |
| 45 | POST | `/patients/{patientId}/unrestrict` | V | Cl | `patients:restrict` | sec | – | | | FR-PAT-01 | B2 | **New** |
| 46 | GET | `/patients/{patientId}/timeline` | V | C | `timeline:read` | pr | – | | | FR-PAT-02 | B4 | Moved to B4 (reads clinical data) |
| 47 | GET | `/duplicates` | V | Ad | `duplicates:read` | pr | – | | | FR-PAT-01 | B2 | |
| 48 | POST | `/duplicates/{duplicateId}/merge` | V | Ad+Cl | `duplicates:merge` | pw | S | | | FR-PAT-01 | B2 | |
| 233 | POST | `/duplicates/{duplicateId}/dismiss` | V | Ad | `duplicates:dismiss` | sec | S | | | FR-PAT-01 | B2 | **New** (D46, 2026-10-23): dismiss a false match with a required reason; audited as `security` with both patient IDs |
| 49 | POST | `/patient-merges/{mergeId}/undo` | V | Ad+Cl | `patient-merges:undo` | pw | S | | | FR-PAT-01 | B2 | |
| 240 | GET | `/patient-merges` | V | Ad | `patient-merges:read` | pr | – | | | FR-PAT-01 | B2 | **New** (D51, 2026-10-24): query `patientId`; merge ID, status, `undoAllowed` |
| 241 | POST | `/patients/summaries` | V | Cl | `patients:read` | pr | – | | | FR-PAT-01 | B2 | **New** (D54, 2026-10-24): up to 50 IDs in the body; each ID returned is audited |

## 3. Scheduling, check-in, eligibility — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 50 | GET | `/slots` | V | C | `slots:read` | – | – | | | FR-SCH-01 | B3 | Query `providerId`, `date`, `appointmentTypeId`, `facilityId` |
| 51 | POST | `/appointments` | V | Cl | `appointments:create` | pw | S | | | FR-SCH-01 | B3 | Also queues eligibility (VD-G3) |
| 52 | GET | `/appointments` | V | Cl | `appointments:read` | pr | – | | | FR-SCH-01 | B3 | Query `date` or `dateFrom`+`dateTo` (≤ 31 days, D62), `providerId`, `facilityId`, `patientId`, `status` |
| 53 | GET | `/appointments/{appointmentId}` | V | Cl | `appointments:read` | pr | – | | | FR-SCH-01 | B3 | **New** (single read missing from CAT) |
| 54 | PATCH | `/appointments/{appointmentId}` | V | Cl | `appointments:update` | pw | – | ✓ | | FR-SCH-01 | B3 | Room, reason for visit, notes, instructions; no slot or time fields (D61): rescheduling is only #243 |
| 243 | POST | `/appointments/{appointmentId}/reschedule` | V | Cl | `appointments:reschedule` | pw | S | | | FR-SCH-01 | B3 | **New** (D61, 2026-10-24): cancels the old slot, books the new one, sets `rescheduledFromId`; reason required |
| 242 | POST | `/appointments/{appointmentId}/undo-check-in` | V | Cl | `appointments:undo-check-in` | pw | – | | | FR-SCH-02 | B3 | **New** (D55, 2026-10-24): before rooming and any clinical data; encounter → entered-in-error |
| 55 | POST | `/appointments/{appointmentId}/cancel` | V | Cl | `appointments:cancel` | pw | – | | | FR-SCH-01 | B3 | |
| 56 | POST | `/appointments/{appointmentId}/check-in` | V | Cl | `appointments:check-in` | pw | R | | | FR-SCH-02 | B3 | Creates Encounter (VD-G4); eligibility (VD-G3) — reaches a partner, so key required |
| 57 | POST | `/appointments/{appointmentId}/status` | V | Cl+Ad | `appointments:status` | pw | – | | | FR-SCH-02 | B3 | Values: `arrived`, `roomed`, `with-provider`, `checked-out`, `noshow` (DATA_OWNERSHIP §5.1) |
| 58 | GET | `/status-board` | V | C | `status-board:read` | pr | – | | | FR-SCH-02 | B3 | `facilityName` in both views; staff view adds `appointmentType`, `reasonForVisit`, `encounterId` (D60) |
| 236 | GET | `/booking/facilities` | V | Cl | `scheduling-reference:read` | – | – | | | FR-SCH-01 | B3 | **New** (D49, 2026-10-24): bookable fields only; reference data |
| 237 | GET | `/booking/locations` | V | Cl | `scheduling-reference:read` | – | – | | | FR-SCH-01 | B3 | **New** (D49) |
| 238 | GET | `/booking/providers` | V | Cl | `scheduling-reference:read` | – | – | | | FR-SCH-01 | B3 | **New** (D49): no NPI, licenses or contact details |
| 239 | GET | `/booking/appointment-types` | V | Ad | `scheduling-reference:read` | – | – | | | FR-SCH-01 | B3 | **New** (D49) |
| 59 | POST | `/eligibility-checks` | V | Ad | `eligibility-checks:create` | pw | R | | ✓ | FR-RCM-01 | B3 | |
| 60 | GET | `/eligibility-checks/{eligibilityCheckId}` | V | Ad | `eligibility-checks:read` | pr | – | | | FR-RCM-01 | B3 | |
| 61 | GET | `/appointments/{appointmentId}/eligibility-checks` | V | Ad | `eligibility-checks:read` | pr | – | | | FR-RCM-01 | B3 | **New** (Stage 1 gap) |

## 4. Encounters and notes — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 62 | POST | `/encounters` | V | Cl | `encounters:create` | pw | S | | | FR-ENC-01 | B4 | Unscheduled encounters only (VD-G4) |
| 63 | GET | `/encounters/{encounterId}` | V | Cl | `encounters:read` | pr | – | | | FR-ENC-01 | B4 | Workspace data |
| 64 | PATCH | `/encounters/{encounterId}` | V | Cl | `encounters:update` | pw | – | ✓ | | FR-ENC-01 | B4 | |
| 65 | GET | `/patients/{patientId}/encounters` | V | Cl | `encounters:read` | pr | – | | | FR-PAT-02 | B4 | **New** (Stage 1 gap) |
| 66 | POST | `/encounters/{encounterId}/close` | V | Cl | `encounters:close` | pw | – | | | FR-ENC-01 | B4 | Publishes `encounter.closed` |
| 67 | POST | `/encounters/{encounterId}/entered-in-error` | V | Cl | `encounters:entered-in-error` | pw | – | | | FR-ENC-01 | B4 | **New** (VD-G6 pattern) |
| 68 | POST | `/encounters/{encounterId}/vitals` | V | Cl | `vitals:create` | pw | S | | | FR-ENC-03, FR-SCH-02 | B4 | |
| 69 | GET | `/patients/{patientId}/vitals` | V | Cl | `vitals:read` | pr | – | | | FR-ENC-03 | B4 | |
| 70 | POST | `/patients/{patientId}/vitals/{vitalId}/entered-in-error` | V | Cl | `vitals:entered-in-error` | pw | – | | | FR-ENC-03 | B4 | **New** (VD-G6) |
| 71 | POST | `/encounters/{encounterId}/diagnoses` | V | Cl | `diagnoses:create` | pw | S | | | FR-ENC-02 | B4 | |
| 72 | POST | `/encounters/{encounterId}/diagnoses/{diagnosisId}/remove` | V | Cl | `diagnoses:remove` | pw | – | | | FR-ENC-02 | B4 | **Was `DELETE`** (VD-G1); only while unsigned |
| 73 | POST | `/encounters/{encounterId}/diagnoses/{diagnosisId}/entered-in-error` | V | Cl | `diagnoses:entered-in-error` | pw | – | | | FR-ENC-02 | B4 | **New** (VD-G1, VD-G6); after signing |
| 74 | GET | `/codes` | V | Ad | `codes:read` | – | – | | | FR-ENC-02 | B4 | Query `system`, `q` (reference data, not PHI). **Was `/codes/search`** (batch 2, 2026-10-24): the `/search` suffix is POST-only for PHI searches (`shri-search-post`), so code search is a GET on `/codes`, like `/pharmacies` |
| 75 | POST | `/encounters/{encounterId}/notes` | V | Cl | `notes:create` | pw | S | | | FR-ENC-01, FR-ENC-04 | B4 | |
| 76 | GET | `/encounters/{encounterId}/notes` | V | Cl | `notes:read` | pr | – | | | FR-ENC-01 | B4 | **New** (Stage 1 gap) |
| 77 | GET | `/notes/{noteId}` | V | Cl | `notes:read` | pr | – | | | FR-ENC-01 | B4 | **New** (Stage 1 gap) |
| 78 | PATCH | `/notes/{noteId}` | V | Cl | `notes:update` | pw | – | ✓ | | FR-ENC-01 | B4 | Autosave |
| 79 | POST | `/notes/{noteId}/sign` | V | Cl | `notes:sign` | sg | – | ✓ | | FR-ENC-01, AI §3.4 | B4 | Guard: every AI suggestion decided |
| 80 | POST | `/notes/{noteId}/addenda` | V | Cl | `note-addenda:create` | sg | S | ✓ | | FR-ENC-01 | B4 | |
| 81 | POST | `/notes/{noteId}/cosign` | V | Cl | `notes:cosign` | sg | – | ✓ | | FR-ENC-01 | B4 | |
| 82 | GET | `/notes/{noteId}/versions` | V | Cl | `notes:read` | pr | – | | | FR-ENC-01 | B4 | |
| 83 | POST | `/notes/{noteId}/entered-in-error` | V | Cl | `notes:entered-in-error` | pw | – | | | FR-ENC-01 | B4 | **New** (VD-G6) |
| 84 | GET | `/me/favorites` | V | Ad | `favorites:read` | – | – | | | FR-ENC-04 | B4 | **Was `/me/favourites`** (VD-G9) |
| 85 | PUT | `/me/favorites` | V | Ad | `favorites:update` | – | – | ✓ | | FR-ENC-04 | B4 | Same |
| 86 | POST | `/encounters/{encounterId}/after-visit-summary` | V | F+Cl | `after-visit-summaries:create` | ex | S | | ✓ | FR-ENC-06 | B4 | Async PDF |
| 87 | GET | `/cosign-rules` | V | Ad | `cosign-rules:read` | adm | – | | | FR-ENC-01 (co-signature by state and provider) | B4 | **New** (Stage 1 gap); owner Vimal, agreed by Anand (A28, D28) |
| 88 | POST | `/cosign-rules` | V | Ad | `cosign-rules:create` | adm | S | | | FR-ENC-01 | B4 | **New** |
| 89 | PATCH | `/cosign-rules/{cosignRuleId}` | V | Ad | `cosign-rules:update` | adm | – | ✓ | | FR-ENC-01 | B4 | **New** |
| 251 | GET | `/cosign-rules/{cosignRuleId}` | V | Ad | `cosign-rules:read` | adm | – | | | FR-ENC-01 | B4 | **New** (batch 2, 2026-10-24): the ETag for #89 (list items carry none, API_STANDARDS §11) |

## 5. Patient history — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 90 | GET | `/patients/{patientId}/problems` | V | Cl | `problems:read` | pr | – | | | FR-PAT-03 | B4 | |
| 91 | POST | `/patients/{patientId}/problems` | V | Cl | `problems:create` | pw | S | | | FR-PAT-03 | B4 | |
| 249 | GET | `/patients/{patientId}/problems/{problemId}` | V | Cl | `problems:read` | pr | – | | | FR-PAT-03 | B4 | **New** (batch 2, 2026-10-24): the ETag for #92 |
| 92 | PATCH | `/patients/{patientId}/problems/{problemId}` | V | Cl | `problems:update` | pw | – | ✓ | | FR-PAT-03 | B4 | |
| 93 | POST | `/patients/{patientId}/problems/{problemId}/entered-in-error` | V | Cl | `problems:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | **Replaces generic `/records/{type}/{rid}/entered-in-error`** (VD-G6) |
| 94 | GET | `/patients/{patientId}/allergies` | V | Cl | `allergies:read` | pr | – | | | FR-PAT-03, FR-MED-01 | B4 | |
| 95 | POST | `/patients/{patientId}/allergies` | V | Cl | `allergies:create` | pw | S | | | FR-PAT-03 | B4 | |
| 250 | GET | `/patients/{patientId}/allergies/{allergyId}` | V | Cl | `allergies:read` | pr | – | | | FR-PAT-03 | B4 | **New** (batch 2, 2026-10-24): the ETag for #96 |
| 96 | PATCH | `/patients/{patientId}/allergies/{allergyId}` | V | Cl | `allergies:update` | pw | – | ✓ | | FR-PAT-03 | B4 | |
| 97 | POST | `/patients/{patientId}/allergies/{allergyId}/entered-in-error` | V | Cl | `allergies:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |
| 98 | GET | `/patients/{patientId}/family-history` | V | Cl | `family-history:read` | pr | – | | | FR-PAT-03 | B4 | |
| 99 | POST | `/patients/{patientId}/family-history` | V | Cl | `family-history:create` | pw | S | | | FR-PAT-03 | B4 | |
| 100 | POST | `/patients/{patientId}/family-history/{familyHistoryId}/entered-in-error` | V | Cl | `family-history:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |
| 101 | GET | `/patients/{patientId}/social-history` | V | Cl | `social-history:read` | pr | – | | | FR-PAT-03 | B4 | |
| 102 | POST | `/patients/{patientId}/social-history` | V | Cl | `social-history:create` | pw | S | | | FR-PAT-03 (smoking status) | B4 | |
| 103 | POST | `/patients/{patientId}/social-history/{socialHistoryId}/entered-in-error` | V | Cl | `social-history:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |
| 104 | GET | `/patients/{patientId}/surgical-history` | V | Cl | `surgical-history:read` | pr | – | | | FR-PAT-03 | B4 | |
| 105 | POST | `/patients/{patientId}/surgical-history` | V | Cl | `surgical-history:create` | pw | S | | | FR-PAT-03 | B4 | |
| 106 | POST | `/patients/{patientId}/surgical-history/{surgicalHistoryId}/entered-in-error` | V | Cl | `surgical-history:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |

## 6. AI — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 107 | POST | `/encounters/{encounterId}/audio` | V | F+Ad | `encounter-audio:create` | ai | S | | | AI-01 (incl. uploaded audio) | B7 | Body references `fileId`s; recording consent checked |
| 108 | POST | `/ai/transcriptions` | V | Ad | `transcriptions:create` | ai | S | | ✓ | AI-01 | B7 | |
| 109 | GET | `/ai/transcriptions/{transcriptionId}` | V | Ad | `transcriptions:read` | pr | – | | | AI-01 | B7 | |
| 110 | POST | `/ai/note-drafts` | V | Ad→Cl | `note-drafts:create` | ai | S | | ✓ | AI-01 | B7 | Result is a draft note (VD-G11) |
| 111 | POST | `/ai/chart-summaries` | V | Ad | `chart-summaries:create` | ai | S | | ✓ | AI-02 | B7 | |
| 112 | GET | `/ai/chart-summaries/{chartSummaryId}` | V | Ad | `chart-summaries:read` | pr | – | | | AI-02 | B7 | **New** (result of the operation) |
| 113 | POST | `/ai/suggestions/{suggestionId}/decision` | V | Ad | `ai-suggestions:decision` | ai | S | | | §3.4 traceability | B7 | |
| 114 | GET | `/admin/ai-settings` | V | Ad | `ai-settings:read` | adm | – | | | §3.4 kill switch, §3.10 | B7 | |
| 115 | PUT | `/admin/ai-settings` | V | Ad | `ai-settings:update` | adm | – | ✓ | | §3.4 | B7 | |

## 7. Medications and prescriptions — Thulasi (signed off, issue #3)

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 116 | GET | `/patients/{patientId}/medications` | T | Cl | `medications:read` | pr | – | | | FR-MED-01 | B5 | |
| 117 | POST | `/patients/{patientId}/medications` | T | Cl | `medications:create` | pw | S | | | FR-MED-01 | B5 | |
| 118 | POST | `/medications/{medicationId}/discontinue` | T | Cl | `medications:discontinue` | pw | – | | | FR-MED-01 | B5 | |
| 119 | POST | `/patients/{patientId}/medication-reconciliation` | T | Cl | `medication-reconciliations:create` | pw | S | | | FR-MED-01, FR-SCH-02 rooming | B5 | |
| 120 | POST | `/prescriptions` | T | Cl | `prescriptions:create` | pw | S | | | FR-MED-01 | B5 | |
| 121 | GET | `/prescriptions/{prescriptionId}` | T | Cl | `prescriptions:read` | pr | – | | | FR-MED-01 | B5 | **New** (agreed, T31) |
| 122 | PATCH | `/prescriptions/{prescriptionId}` | T | Cl | `prescriptions:update` | pw | – | ✓ | | FR-MED-01 | B5 | **New** (agreed, T31): **drafts only**; a signed prescription → `409 record-locked` |
| 227 | POST | `/prescriptions/{prescriptionId}/entered-in-error` | T | Cl | `prescriptions:entered-in-error` | pw | – | | | FR-MED-01 | B5 | **New** (T34): drafts only; anything already sent uses cancel |
| 123 | POST | `/prescriptions/{prescriptionId}/safety-check` | T | Cl | `prescriptions:safety-check` | pw | – | | | FR-MED-01, §3.4 CDS layer 1 | B5 | |
| 124 | POST | `/alerts/{alertId}/override` | T | Cl | `alerts:override` | pw | – | | | §3.4 | B5 | |
| 125 | POST | `/prescriptions/{prescriptionId}/sign-and-send` | T | Cl | `prescriptions:sign-and-send` | sg | R | ✓ | | FR-MED-01 | B5 | |
| 126 | POST | `/prescriptions/{prescriptionId}/cancel` | T | Cl | `prescriptions:cancel` | pw | R | | | FR-MED-01 | B5 | Sets `transmissionStatus: cancel-requested` until the pharmacy confirms (T35) |
| 127 | POST | `/prescriptions/{prescriptionId}/change` | T | Cl | `prescriptions:change` | sg | R | ✓ | | FR-MED-01 | B5 | A CancelRx plus a NewRx linked by `replaces` (T35) |
| 128 | GET | `/refill-requests` | T | Ad | `refill-requests:read` | pr | – | | | FR-MED-01, FR-ENC-05 | B5 | Items carry `type`: `renewal` \| `change` (pharmacy RxChangeRequest via `/hooks/erx`; depends on the e-prescribing vendor; T35) |
| 129 | POST | `/refill-requests/{refillRequestId}/respond` | T | Ad+Cl | `refill-requests:respond` | sg | R | | | FR-MED-01 | B5 | Answers both renewal and change requests (T35) |
| 130 | GET | `/pharmacies` | T | Ad | `pharmacies:read` | – | – | | | FR-PAT-01, FR-MED-01 | B1 | Query `q`, `postalCode`, `mailOrder` (pharmacy data, not PHI). **Moved to batch 1** (D50, 2026-10-24); contract written |
| 131 | POST | `/patients/{patientId}/medication-history/fetch` | T | Cl | `medication-history:fetch` | pr | R | | ✓ | FR-MED-01 | B5 | |

## 8. Orders and results — Thulasi (signed off, issue #3)

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 132 | GET | `/lab-compendium` | T | Ad | `lab-compendium:read` | – | – | | | FR-ORD-01 | B5 | Query `labId`, `q` |
| 133 | GET | `/lab-compendium/{testId}/questions` | T | Ad | `lab-compendium:read` | – | – | | | FR-ORD-01 (AOE) | B5 | |
| 134 | POST | `/orders` | T | Cl | `orders:create` | pw | S | | | FR-ORD-01 | B5 | |
| 135 | GET | `/orders` | T | Cl | `orders:read` | pr | – | | | FR-ORD-01 | B5 | Query `patientId`, `status` |
| 136 | GET | `/orders/{orderId}` | T | Cl | `orders:read` | pr | – | | | FR-ORD-01 | B5 | **New** (agreed, T32) |
| 137 | POST | `/orders/{orderId}/medical-necessity-check` | T | Ad | `orders:medical-necessity-check` | pw | – | | | FR-ORD-01 (ABN) | B5 | |
| 138 | POST | `/orders/{orderId}/sign-and-send` | T | Cl | `orders:sign-and-send` | sg | R | ✓ | | FR-ORD-01 | B5 | |
| 139 | POST | `/orders/{orderId}/cancel` | T | Cl | `orders:cancel` | pw | R | | | FR-ORD-01 | B5 | Only before `specimen-collected`; after → `409 invalid-state-transition` (T34) |
| 228 | POST | `/orders/{orderId}/entered-in-error` | T | Cl | `orders:entered-in-error` | pw | – | | | FR-ORD-01 | B5 | **New** (permission from T13). **Drafts only, confirmed by Thulasi** (issue #3): it mirrors prescriptions; a signed order uses cancel (#139), before specimen collection |
| 140 | GET | `/orders/{orderId}/requisition` | T | F | `orders:read` | ex | – | | | FR-ORD-01 | B5 | Returns a file download link, generated on demand through the file service; audited as `ex` (agreed, T33) |
| 141 | GET | `/orders/{orderId}/labels` | T | F | `orders:read` | ex | – | | | FR-ORD-01 | B5 | Same |
| 142 | GET | `/results` | T | Cl | `results:read` | pr | – | | | FR-ORD-02 | B5 | Query `unreviewed`, `patientId` |
| 143 | GET | `/results/{resultId}` | T | Cl | `results:read` | pr | – | | | FR-ORD-02 | B5 | |
| 144 | POST | `/results/{resultId}/acknowledge` | T | Ad | `results:acknowledge` | pw | – | | | FR-ORD-02 | B5 | |
| 145 | GET | `/unmatched-results` | T | Ad | `unmatched-results:read` | pr | – | | | FR-ORD-02 | B5 | |
| 146 | POST | `/unmatched-results/{unmatchedResultId}/match` | T | Ad+Cl | `unmatched-results:match` | pw | – | | | FR-ORD-02 | B5 | Body `{ patientId, orderId? }`: `orderId` optional for outside results with no order of ours (T35) |
| 229 | POST | `/unmatched-results/{unmatchedResultId}/reject` | T | Ad | `unmatched-results:reject` | pw | – | | | FR-ORD-02 | B5 | **New** (T34): `{ reason }`; rejected items are kept, never deleted |
| 147 | POST | `/encounters/{encounterId}/in-office-results` | T | Cl | `in-office-results:create` | pw | S | | | FR-ORD-02 | B5 | |

## 9. Files, practice setup, billing, documents, inbox, exports — Anand

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 148 | POST | `/files/upload-url` | A | F | `files:create` | pw | S | | | §3.9 | B1 | **Contract written in the batch 1 follow-up** (2026-10-24, D52): returns `201` with the upload ticket |
| 149 | POST | `/files/{fileId}/complete` | A | F | `files:create` | pw | – | | ✓ | §3.9, TA §9 scan | B1 | Scan is async: operation kind `file.scan`. **Contract written in the batch 1 follow-up** (2026-10-24, D52) |
| 150 | GET | `/files/{fileId}/download-url` | A | F | `files:read` | ex | – | | | §3.9 | B1 | Plus purpose-based check. **Contract written in the batch 1 follow-up** (2026-10-24, D52) |
| 151–154 | GET, POST, GET `{facilityId}`, PATCH `{facilityId}` | `/facilities` | A | Cl | `practice-setup:read\|create\|update` | adm | S on POST | ✓ on PATCH | | §3.10 | B1 | Single GET added |
| 155–158 | same 4 | `/locations` | A | Cl | same | adm | S | ✓ | | §3.10 | B1 | Same |
| 159–162 | same 4 | `/providers` | A | Cl | same | adm | S | ✓ | | §3.10 (NPIs) | B1 | Same |
| 163–166 | same 4 | `/appointment-types` | A | Ad | same | adm | S | ✓ | | FR-SCH-01 | B1 | Same |
| 167–170 | same 4 | `/provider-schedules` | A | Ad | `practice-setup:read`; writes `provider-schedules:create\|update` (FD, ADM; D66) | adm | S | ✓ | | FR-SCH-01 | B1 | Same. Writes split from `practice-setup:*` (D66, 2026-10-24) |
| 171–174 | same 4 | `/fee-schedules` | A | Ad | same | adm | S | ✓ | | FR-RCM-02 | B1 | Same |
| 175–178 | same 4 | `/practice-payers` | A | Ad | same | adm | S | ✓ | | FR-RCM-01, §3.10 onboarding | B1 | **Was `/payers`** (Vimal, 2026-10-23): the practice's own payer setup, a payer chosen from the directory plus its enrollment status per transaction (`payer_enrollment`); practice-level table `practice_payer` (A39, in the locked schema) |
| 230 | GET | `/payers` | A | Ad | `payers:read` | – | – | | | FR-RCM-01 | B1 | **New** (Vimal, 2026-10-23): the platform payer directory, read-only; filters `payerName`, `externalPayerId`, `payerType`. Reference data, audit category `none` |
| 231 | GET | `/payers/{payerId}` | A | Ad | `payers:read` | – | – | | | FR-RCM-01 | B1 | **New**: one directory payer |
| 234 | GET | `/lab-providers` | A | Ad | `lab-providers:read` | – | – | | | FR-ORD-01, §3.10 onboarding | B1 | **New** (D48, 2026-10-23): read-only, like the payer directory |
| 235 | GET | `/lab-providers/{labProviderId}` | A | Ad | `lab-providers:read` | – | – | | | FR-ORD-01 | B1 | **New** (D48) |
| 179–182 | same 4 | `/lab-accounts` | A | Ad | same | adm | S | ✓ | | FR-ORD-01 | B1 | Same |
| 183–186 | same 4 | `/note-templates` | A | Ad | same | adm | S | ✓ | | FR-ENC-04 | B1 | Same; the two GETs take `note-templates:read` (D73, T42) so clinicians can start a templated note (2026-10-27) |
| 244–247 | same 4 | `/consent-requirements` | A | Ad | reads `consent-requirements:read` (FD, ADM); writes `practice-setup:create\|update` | adm | S | ✓ | | FR-PAT-01 | B1 | **New** (D59, 2026-10-24): consent kinds with the current `policyVersion` |
| 258–259 | GET, PATCH | `/practice-settings` | A | Ad | `practice-setup:read`; `practice-setup:update` (ADM) | adm | – | ✓ (PATCH) | | D39 | B1 | **New** (contracts follow-up 2, 2026-10-26, D39 amended): one setting today, whether registration shows the sexual-orientation and gender-identity fields; every signed-in user reads it through `GET /me` (`practiceSettings`). The response also carries the read-only `mrnPrefix` and `mrnSystem`, set at onboarding (D41; Anand's ask on #74, 2026-10-27) |
| 187 | POST | `/onboarding/import` | A | Ad+F | `onboarding:import` | adm | S | | ✓ | §3.10 onboarding | B1 | |
| 188 | GET | `/encounters/{encounterId}/superbill` | A | Cl | `superbills:read` | pr | – | | | FR-RCM-02 | B6 | |
| 189 | PATCH | `/encounters/{encounterId}/superbill` | A | Cl | `superbills:update` | pw | – | ✓ | | FR-RCM-02 | B6 | |
| 190 | POST | `/claims` | A | Ad | `claims:create` | pw | S | | | FR-RCM-02 | B6 | |
| 191 | GET | `/claims` | A | Ad | `claims:read` | pr | – | | | FR-RCM-02 | B6 | Query `status` |
| 192 | GET | `/claims/{claimId}` | A | Ad | `claims:read` | pr | – | | | FR-RCM-02 | B6 | |
| 193 | POST | `/claims/{claimId}/scrub` | A | Ad | `claims:scrub` | pw | – | | | FR-RCM-02 | B6 | |
| 194 | POST | `/claims/{claimId}/submit` | A | Ad | `claims:submit` | pw | R | | | FR-RCM-02 | B6 | |
| 195 | POST | `/claims/{claimId}/status-check` | A | Ad | `claims:status-check` | pr | R | | | FR-RCM-02 | B6 | |
| 196 | POST | `/claims/{claimId}/correct` | A | Ad | `claims:correct` | pw | R | | | FR-RCM-02 | B6 | |
| 197 | POST | `/claims/{claimId}/void` | A | Ad | `claims:void` | pw | R | | | FR-RCM-02 | B6 | |
| 198 | POST | `/patients/{patientId}/payments` | A | Ad | `payments:create` | pw | R | | | FR-RCM-03, FR-SCH-02 copay | B1 | Charges money. **Moved to batch 1** (D58, 2026-10-24): response carries `receiptFileId` |
| 199 | POST | `/payments/card-session` | A | Ad | `payments:card-session` | pw | R | | | FR-RCM-03 | B1 | **Moved to batch 1** (D58): hosted fields token, card numbers never reach our servers |
| 200 | GET | `/remittances` | A | Ad | `remittances:read` | pr | – | | | FR-RCM-03 | B6 | |
| 201 | POST | `/remittances/{remittanceId}/post` | A | Ad | `remittances:post` | pw | S | | | FR-RCM-03 (P0 stretch) | B6 | |
| 202 | GET | `/reports/ar-aging` | A | C | `billing-reports:read` | pr | – | | | FR-RCM-03 | B6 | |
| 203 | GET | `/reports/charges-payments` | A | C | `billing-reports:read` | pr | – | | | FR-RCM-03 | B6 | |
| 204 | GET | `/documents` | A | Cl+F | `documents:read` | pr | – | | | §3.9 | B3 | |
| 205 | GET | `/patients/{patientId}/documents` | A | Cl+F | `documents:read` | pr | – | | | §3.9 | B3 | |
| 206 | POST | `/documents` | A | Cl+F | `documents:create` | pw | S | | | §3.9 | B3 | |
| 207 | GET | `/documents/{documentId}` | A | Cl+F | `documents:read` | pr | – | | | §3.9 | B3 | Single GET implied by CAT |
| 208 | PATCH | `/documents/{documentId}` | A | Cl+F | `documents:update` | pw | – | ✓ | | §3.9 | B3 | |
| 209 | POST | `/faxes` | A | Ad+F | `faxes:create` | ex | R | | | §3.9 | B3 | Reaches a partner |
| 210 | GET | `/fax-inbox` | A | Ad+F | `fax-inbox:read` | pr | – | | | §3.9 | B3 | |
| 211 | POST | `/fax-inbox/{faxId}/file` | A | Ad+F | `fax-inbox:file` | pw | – | | | §3.9 | B3 | |
| 212 | POST | `/ccda/import` | A | Cl+F | `ccda:import` | pw | S | | ✓ | §3.9 | B6 | |
| 213 | GET | `/patients/{patientId}/ccda` | A | F | `ccda:export` | ex | – | | | §3.9 | B6 | **Anand's call (A27, D28):** if generation is slow, change to `POST /patients/{patientId}/ccda-exports` → 202 (API_STANDARDS §13) |
| 214 | GET | `/inbox` | A | Ad | `inbox:read` | pr | – | | | FR-ENC-05 | B3 | **Written in batch 3** (2026-10-26, D77): `view`, `itemType`, `status`, `priority`, `patientId`, `facilityId`, `dueBefore`; only kinds the user may read; restricted charts without access listed without the patient (D37) |
| 252 | GET | `/inbox/{inboxItemId}` | A | Ad | `inbox:read` | pr | – | | | FR-ENC-05 | B3 | **New** (batch 3, D77): the item with its thread and the `ETag` #215 needs |
| 255 | GET | `/inbox/summary` | A | Ad | `inbox:read` | – | – | | | FR-ENC-05 | B3 | **New** (batch 3, D77, Q10): badge counts only, no patient data |
| 215 | PATCH | `/inbox/{inboxItemId}` | A | Ad | `inbox:update` | pw | – | ✓ | | FR-ENC-05 | B3 | Take from a queue, reassign (ADM at their facilities, Q5), status `open`/`in-progress`/`on-hold`, priority, due time |
| 216 | POST | `/inbox/{inboxItemId}/complete` | A | Ad | `inbox:complete` | pw | – | | | FR-ENC-05 | B3 | Kinds that wait for an action are completed by it, not here (Q4) |
| 253 | POST | `/inbox/{inboxItemId}/cancel` | A | Ad | `inbox:update` | pw | – | | | FR-ENC-05 | B3 | **New** (batch 3, D77): a message or task closed by its creator, with a reason; nothing is deleted (D14) |
| 254 | POST | `/inbox/{inboxItemId}/replies` | A | Ad | `messages:create` | pw | S | | | FR-ENC-05 | B3 | **New** (batch 3, D77): message threads (D38); hands the item back to the other party |
| 217 | POST | `/messages` | A | Ad | `messages:create` | pw | S | | | FR-ENC-05 | B3 | **Written in batch 3** (D77): `kind` `message` or `task`, one user or role, facility, title, body, priority, due time, optional patient and linked record (D67, D80) |
| 218 | POST | `/exports` | A | Ad+F | `exports:create` | ex | S | | ✓ | §3.10 | B6 | |
| 219 | GET | `/exports/{exportId}` | A | Ad+F | `exports:read` | ex | – | | | §3.10 | B6 | |

## 10. Communications and dashboard — Minalini

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 220 | GET | `/message-templates` | M | Ad | `message-templates:read` | – | – | | | §3.9 | B3 | |
| 221 | POST | `/message-templates` | M | Ad | `message-templates:create` | adm | S | | | §3.9 | B3 | |
| 222 | PATCH | `/message-templates/{messageTemplateId}` | M | Ad | `message-templates:update` | adm | – | ✓ | | §3.9 | B3 | Also retires a template: `active: false` (no DELETE, D14); M16 |
| 248 | GET | `/message-templates/{messageTemplateId}` | M | Ad | `message-templates:read` | – | – | | | §3.9 | B3 | **New** (M16, 2026-10-24): returns the template with its `ETag`, which #222 needs for `If-Match` (list items carry no ETag, API_STANDARDS §11). Templates carry `active` (default `true`); the list returns active templates unless asked for all |
| 223 | GET | `/patients/{patientId}/communication-preferences` | M | Ad | `communication-preferences:read` | pr | – | | | §3.9 | B3 | |
| 224 | PUT | `/patients/{patientId}/communication-preferences` | M | Ad | `communication-preferences:update` | pw | – | ✓ | | §3.9 | B3 | |
| 225 | GET | `/patients/{patientId}/communications` | M | Ad | `communications:read` | pr | – | | | §3.9 | B3 | |
| 226 | GET | `/dashboards/operations` | M | C | `operations-dashboard:read` | – | – | | | §3.10 | B6 | Counts only, no PHI |

---

## Summary of changes from API_Catalogue.md

| Change | Endpoints | Decision |
|---|---|---|
| PHI search moved to POST | `GET /patients?search=` → `POST /patients/search` | VD-G2 |
| DELETE removed | `DELETE /encounters/{id}/diagnoses` → `POST …/diagnoses/{diagnosisId}/remove` and `…/entered-in-error` | VD-G1 |
| Generic entered-in-error split per type | `/records/{type}/{rid}/entered-in-error` → 9 per-type actions (#67, #70, #73, #83, #93, #97, #100, #103, #106) | VD-G6 |
| U.S. spelling | `/me/favourites` → `/me/favorites` | VD-G9 |
| `POST /encounters` scope | Unscheduled encounters only | VD-G4 |
| New endpoints from the Stage 1 gaps | #34–36, #44–45, #53, #61, #65, #76–77, #87–89 | Vimal, Stage 1 review |
| New endpoints from Stage 2 design | #15–16 (operations), #112 (chart summary read) | API_STANDARDS §13 |
| Agreed by Thulasi (issue #3) | #121–122, #136, #140–141 (links), new #227–229, state changes on #126–129, #139, #146; `/hooks/*` audited as `pw` | T31–T37 |
| Payers in two layers (Vimal, 2026-10-23) | `/payers` (#175–178) → `/practice-payers`; new read-only directory #230–231 (`payers:read`) | Needs Anand's review |
| Batch 1 review decisions (2026-10-23) | #232 coverage entered-in-error (D45), #233 dismiss a duplicate (D46), #234–235 read-only lab providers (D48) | Decided |
| Proposed to owners | Single GETs in practice setup and documents (Anand), #213 async export (Anand) | Pending owners |
| Batch 1 follow-up: Minalini's screen-mapping gaps (2026-10-24) | New #236–239 booking lists (D49), #240 merge list (D51), #241 summaries (D54), #242 undo check-in (D55), #243 reschedule (D61), #244–247 consent requirements (D59); #1–6, #14, #19, #148–150 written (D52, D53); #130 and #198–199 moved to batch 1 (D50, D58); `provider-schedules:create\|update` (D66) | D49–D70 |
| Contract batch 3: inbox, tasks and messages (2026-10-26) | #214–217 written; new #252 (single GET), #253 (cancel), #254 (replies), #255 (summary) | D77–D81 |
| Contracts follow-up 2 (2026-10-26) | New #256 single coverage, #257 single related person, #258–259 practice settings; `GET /me` gains `practiceSettings` | D39 (amended), D82 |
| Moved outside `/api/v1` | `/hooks/*`, `/health` (public through Nginx); `/ready` internal and **not in the contract** | API_STANDARDS §2; agreed T24 |

**Count:** 254 contract operations: 255 rows (27 platform, 24 patients, 12 scheduling and eligibility, 29 encounters and notes, 19 history, 9 AI, 17 medications, 18 orders, 80 Anand, 8 Minalini) minus `/ready` (#27), which is not in the contract. New rows are numbered from #227 so existing references stay valid; #230–231 are the payer directory, #232–235 come from D45, D46 and D48 (2026-10-23); #236–247 from the batch 1 follow-up (D49–D61, 2026-10-24); #248 from Minalini's M16 sign-off (2026-10-24); #249–251 from batch 2 (single GETs for problems, allergies and co-sign rules, 2026-10-24); #252–255 from batch 3 (inbox, 2026-10-26); #260–291 from portal batch B8a (D89, D92, 2026-10-26; P1, so not in the count above). Recounted when the contract is written.

## Later batches: items recorded on 2026-10-24 (no contract change now)

Minalini's clinical items from the screen mapping, to be written in the batch named; each gets its contract there, not before.

| Item | Batch | Note |
|---|---|---|
| Inbox task creation (`POST /messages`, #217) with assignee, due date and link to a record; clinicians request appointment changes this way (D67) | B3 | **Done in batch 3** (D77): `kind: task` |
| **Not in the MVP:** a self-service out-of-office forward for clinicians who are away. Until then, ADM reassigns their items and overdue items escalate (D79) | P1 | Anand |
| **Not in the MVP:** read / unread marks on inbox items (batch 3 plan Q11) | P1 | Anand, Minalini |
| Co-sign "return to author" with a comment (`POST /notes/{noteId}/cosign` with `decision: return`) | B4 | **Done in batch 2:** `cosignStatus: returned`; the note stays signed and the author answers with an addendum; event `note.cosign-returned` |
| Where patient instructions are stored (after-visit summary section vs. note section) | B4 | **Done in batch 2:** a note section, LOINC 69730-0, signed with the note and printed on the after-visit summary |
| Timeline filters (`GET /patients/{patientId}/timeline`: type, date range) | B4 | **Done in batch 2:** `types`, `dateFrom`, `dateTo` |
| Personal note templates (user-owned templates next to practice templates) | B4 | Stored with `note_template.owner_user_id` (there is no `user_clinical_preference`); the endpoint and permission are Anand's A46 and Thulasi's T42 (batch 2 plan Q2, Q3) |
| Results: filters (`unreviewed`, `patientId`, date range, abnormal), result versions, `acknowledge` body (comment, patient notified) | B5 | Thulasi |
| Orders: filters, cancel reason body, order sets, duplicate-order check at signing | B5 | Thulasi |
| Medication reconciliation request body (`POST /patients/{patientId}/medication-reconciliation`) | B5 | Thulasi |
| Whole-list interaction check (not only per prescription) | B5 | Thulasi |
| Prescription history per patient (`GET /patients/{patientId}/prescriptions`) | B5 | Thulasi |
| **Confirmed:** drug search is `GET /codes?system=rxnorm` (#74), no separate drug endpoint | B4 | Done in batch 2 |
| **Confirmed:** per-user alert suppression is in-product (FRS §3.4), in the medications batch | B5 | Thulasi |
| Vitals in U.S. customary UCUM units as entered (D69) | B4 | **Done in batch 2** |
| AI contract shapes from Minalini's Stage 3 design (D70) | B7 | Vimal |

## Later batches: patient portal (B8, P1; mapped 2026-10-26)

Minalini's portal screens (#39) and her endpoint note (`frontend/src/features/portal/NOTE_FOR_VIMAL_PORTAL.md`), mapped to the decided shape (D83–D88).
- **Paths:** one `portal.yaml` under `/api/v1/portal`. Patient data sits under `/portal/me/...` with no patient ID; the patient comes from the session (`PAT`, D84). A record ID in a path must belong to the session's patient, otherwise `404`.
- **Ownership:** each operation keeps its owning module's `x-owner` (D83).
- **Release:** everything follows D86: drafts, entered-in-error records and psychotherapy notes are never shown, and items held by a clinician show as held.
- **Status (D89):** **B8a is in the contract** (#260–291 below, `x-release: P1`, served by the mock). The rows marked B8b are still only mapped; they follow their batches (D88).
- **Sign-in and enrollment** follow ADR-0013 (#67, proposed): the patient redeems the code with their date of birth and email **before** any account exists, and only then signs in.

| Screen | Her call | Decided path | x-owner | Staff data it reads | Batch (B8b: what it waits for) |
|---|---|---|---|---|---|
| Session | `GET /auth/session`, `POST /auth/refresh`, `POST /auth/logout` | `GET /portal/auth/session`, `POST /portal/auth/refresh`, `POST /portal/auth/logout` (patient realm, ADR-0013 §5) | thulasi | `admin.portal_session` (ADR-0013 §5) | **B8a** #262–264 |
| Sign-in | `POST /portal/auth/login` | `GET /portal/auth/login`, `GET /portal/auth/callback`: the patient realm's sign-in with multi-factor (code + PKCE), like the staff `#1–2` | thulasi | — | **B8a** #260–261 |
| Enrollment | (replaces registration, below) | `POST /portal/enrollments` `{ invitationCode, birthDate, email }`, public: redeems the code before any account exists, then the realm emails the set-up link (ADR-0013 §3); one answer for every failure. Staff side: `GET /patients/{patientId}/portal-account`, `POST /patients/{patientId}/portal-invitations` (code shown once), `POST …/portal-invitations/{invitationId}/revoke`, `POST /patients/{patientId}/portal-account/reset-factors`, `…/disable` and `…/enable` (ADM, D92) | thulasi (enrollment, factor reset, disable and enable); vimal (invitations, account) | `admin.portal_invitation`, `admin.portal_account` | **B8a** #265, #286–291 |
| Alerts and reminders | `GET /portal/alerts` | No separate endpoint: today's and upcoming appointments are `GET /portal/me/appointments?when=upcoming` | vimal | `appointment` | **B8a** #269 |
| Demographics | `GET`, `PUT /portal/demographics` | `GET /portal/me`; `POST /portal/me/change-requests` (proposed changes go to the front desk as an inbox task, not a direct write; name changes always reviewed) | vimal | `Patient`, `RelatedPerson` (emergency contact), employer (A45) | **B8a** #266–268 |
| E-signature | `GET`, `PUT /portal/signature` | `GET`, `PUT /portal/me/signature` (the PNG through the files flow) | anand | `binary_object` | B8b; B1 (files) |
| Reference lists | `GET /portal/reference-lists` | Not needed for B8a: the lists its screens use are enums in the contract. Revisit with forms | vimal | Code systems | B8b (forms) |
| Appointments | `GET /portal/appointments[/{appointmentId}]`, `POST …/cancel` | `GET /portal/me/appointments[/{appointmentId}]`, `POST /portal/me/appointments/{appointmentId}/cancel` (reason required) | vimal | `appointment` | **B8a** #269, #271–272 |
| Schedule and reschedule | `GET /portal/facilities`, `/portal/appointment-categories`, `/portal/providers`, `POST /portal/slots/search`, `POST /portal/appointments`, `POST …/reschedule` | `GET /portal/booking/facilities`, `/portal/booking/appointment-types`, `/portal/booking/providers` (bookable fields only, as D49); `GET /portal/me/slots?facilityId=&providerId=&appointmentTypeId=&date=` (no PHI, so `GET`); `POST /portal/me/appointments`, `POST /portal/me/appointments/{appointmentId}/reschedule` (`Idempotency-Key`, `409 booking-conflict`). The length comes from the appointment type, not a free 15–60-minute choice | vimal | Scheduling setup, `appointment` | **B8a** #270, #273–277 |
| Visit summary | `GET /portal/visit-summaries/{visitSummaryId}` | `GET /portal/me/visit-summaries`, `GET /portal/me/visit-summaries/{visitSummaryId}` (signed and released only, D86; a held one is listed as held, without content), `GET …/{visitSummaryId}/download-url` (the PDF, short-lived) | vimal | After-visit summary `document_reference` | **B8a** #278–280 |
| Video consult | `POST /portal/appointments/{appointmentId}/video-join` | `POST /portal/me/appointments/{appointmentId}/video-join` → `{ joinUrl }` | vimal | Telehealth appointment; Jitsi (P1) | B8b; B3; telehealth P1 |
| Messages | `GET /portal/messages?folder=`, `POST …/{messageId}/read`, `POST /portal/messages`, `POST …/trash`, `POST …/remove-from-trash`, `GET /portal/message-recipients` | Same, under `/portal/me/messages` and `/portal/me/message-recipients`. Patient messages arrive as inbox `message` items for a role or user (D77); "trash" only hides a message from the patient | anand | `work_item`, `work_item_event` | B8b; B3 (inbox, #58) |
| Test results | `GET /portal/results[/{resultId}]` | `GET /portal/me/results[/{resultId}]` (released per D86; held ones shown as held) | thulasi | `diagnostic_report`, `observation` | B8b; B5 |
| Health issues, allergies | `GET /portal/health-issues[/{id}]`, `/portal/allergies[/{id}]` | `GET /portal/me/problems[/{problemId}]`, `/portal/me/allergies[/{allergyId}]` (entered-in-error excluded, D24) | vimal | `condition`, `allergy_intolerance` | **B8a** #281–284 |
| Immunizations | `GET /portal/immunizations[/{id}]` | `GET /portal/me/immunizations[/{immunizationId}]` | to be decided (immunizations are P1, not in any batch yet) | `immunization` | Immunizations contract (P1) |
| Health trends | `GET /portal/vitals` | `GET /portal/me/vitals` | vimal | `observation` (vital signs) | **B8a** #285 |
| Prescriptions | `GET /portal/prescriptions`, `POST /portal/refill-requests`, `GET /portal/refill-requests/{id}` | `GET /portal/me/medications` (#300, written for the demo: prescriptions and reported medications in one list, with each prescription's transmission status); `POST /portal/me/refill-requests` (lands as a `refill-request` inbox item; controlled substances not refillable); `GET /portal/me/refill-requests/{refillRequestId}` | thulasi | `medication_request`, refill requests | The list: demo (#300). Refills: B8b; B5 |
| Pay bills | `GET /portal/bills`, `POST /portal/payments` | `GET /portal/me/statements` (the ledger and statements are P1, D58); `POST /portal/me/payments/card-session` then `POST /portal/me/payments` (hosted fields only, Q17) | anand | Patient balance, `patient_payment` | B8b; B6; D58 |
| Documents | `GET /portal/documents?source=`, `POST /portal/documents` (multipart), `GET …/{documentId}/content` | `GET /portal/me/documents?source=`; uploads through the files flow (`POST /portal/me/files/upload-url`, then `…/complete`, scanned) and `POST /portal/me/documents`; `GET /portal/me/documents/{documentId}/download-url` (short-lived, not the content) | anand | `document_reference`, `binary_object` | B8b; B1 (files); B3 (documents) |
| Reports | `GET /portal/patient-report`, `…/ccr`, `…/ccd`, `…/pdf` | `POST /portal/me/record-exports` `{ format: ccda \| pdf }` → `202` and an operation, then a download URL (as #213) | anand | C-CDA, PDF | B8b; B6 (C-CDA) |
| Forms | `GET /portal/document-templates[/{id}]`, `PUT …/{id}`, `POST …/send-for-review`, `POST …/clear` | `GET /portal/me/forms[/{formId}]`, `PATCH /portal/me/forms/{formId}` (`If-Match`), `POST /portal/me/forms/{formId}/submit` (signature required), `POST /portal/me/forms/{formId}/clear` | anand | Consent requirements (D59), forms, `consent` | B8b; B1 (D59); B3 (documents) |
| Source code | (not in her note) | A "Source code" link on every portal page, to `/source.tar.gz` on the portal host (the running commit's source, with no version in the link because it shows before sign-in; ADR-0013 §1, D87). Not an API endpoint | thulasi (Nginx), with minalini | The build | — |

**B8a operations (D89, 2026-10-26).** All `x-release: P1`. Portal operations use `portalSessionCookie` and are audited with `actor: patient`, `patient: session` (SECURITY_MODEL §6). The `PAT` grants and the staff grants are proposed in NOTE_FOR_THULASI T45.

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 260 | GET | `/portal/auth/login` | T | Ad | `public` | sec | – | | | §3.8 | B8a | **New**: patient realm sign-in, code + PKCE, `prompt=login`, no `login_hint` (ADR-0013 §1, §5) |
| 261 | GET | `/portal/auth/callback` | T | Ad | `public` | sec | – | | | §3.8 | B8a | **New**: new portal session, `__Host-shri_portal` |
| 262 | GET | `/portal/auth/session` | T | Ad | `authenticated` | – | – | | | §3.8 | B8a | **New**: patient display name, CSRF token, idle and absolute expiry (15 minutes, 4 hours) |
| 263 | POST | `/portal/auth/refresh` | T | Ad | `authenticated` | sec | – | | | §3.8 | B8a | **New**: "Stay signed in" |
| 264 | POST | `/portal/auth/logout` | T | Ad | `authenticated` | sec | – | | | §3.8 | B8a | **New**: also ends the realm session (back channel) |
| 265 | POST | `/portal/enrollments` | T | Ad | `public` | sec | S | | | §3.8 | B8a | **New**: invitation code (any case, dashes optional, normalized on the server) + date of birth + email; `Origin` must be the portal host; `204`; one `422` for every failure (ADR-0013 §3, §5) |
| 266 | GET | `/portal/me` | V | Cl | `portal-profile:read` | pr | – | | | §3.8 | B8a | **New**: own details with pending change requests; preferred language, race, ethnicity, marital status, and sexual orientation and gender identity where the practice shows them (D91) |
| 267 | GET | `/portal/me/change-requests` | V | Ad | `portal-profile:read` | pr | – | | | §3.8 | B8a | **New** |
| 268 | POST | `/portal/me/change-requests` | V | Ad | `portal-profile:request-change` | pw | S | | | §3.8 | B8a | **New**: a front-desk inbox task (D77); nothing on the chart changes until accepted (D91) |
| 269 | GET | `/portal/me/appointments` | V | Cl | `portal-appointments:read` | pr | – | | | §3.8 | B8a | **New**: `when` = `upcoming` or `past`; also feeds the alerts screen; a past visit carries `visitSummaryId` |
| 270 | POST | `/portal/me/appointments` | V | Cl | `portal-appointments:create` | pw | S | | | §3.8 | B8a | **New**: same rules as #51; length from the appointment type; `409 booking-conflict` |
| 271 | GET | `/portal/me/appointments/{appointmentId}` | V | Cl | `portal-appointments:read` | pr | – | | | §3.8 | B8a | **New** |
| 272 | POST | `/portal/me/appointments/{appointmentId}/cancel` | V | Cl | `portal-appointments:cancel` | pw | – | | | §3.8 | B8a | **New**: reason required; inside the practice's online window (`canCancel`) |
| 273 | POST | `/portal/me/appointments/{appointmentId}/reschedule` | V | Cl | `portal-appointments:reschedule` | pw | S | | | §3.8 | B8a | **New**: as #243 (D61), inside the online window (`canReschedule`) |
| 274 | GET | `/portal/booking/facilities` | V | Ad | `portal-booking:read` | – | – | | | §3.8 | B8a | **New**: bookable fields only (as D49) |
| 275 | GET | `/portal/booking/appointment-types` | V | Ad | `portal-booking:read` | – | – | | | §3.8 | B8a | **New**: types bookable online |
| 276 | GET | `/portal/booking/providers` | V | Ad | `portal-booking:read` | – | – | | | §3.8 | B8a | **New** |
| 277 | GET | `/portal/me/slots` | V | C | `portal-booking:read` | – | – | | | §3.8 | B8a | **New**: `facilityId`, `appointmentTypeId`, `date`, optional `providerId` |
| 278 | GET | `/portal/me/visit-summaries` | V | Cl | `portal-records:read` | pr | – | | | §3.8 | B8a | **New**: held ones listed as held (D86) |
| 279 | GET | `/portal/me/visit-summaries/{visitSummaryId}` | V | Cl | `portal-records:read` | pr | – | | | §3.8 | B8a | **New** |
| 280 | GET | `/portal/me/visit-summaries/{visitSummaryId}/download-url` | V | F | `portal-records:read` | ex | – | | | §3.8 | B8a | **New**: short-lived link; `409` while held |
| 281 | GET | `/portal/me/problems` | V | Cl | `portal-records:read` | pr | – | | | §3.8 | B8a | **New**: entered-in-error never shown (D24); a held problem listed as held, without content (D90) |
| 282 | GET | `/portal/me/problems/{problemId}` | V | Cl | `portal-records:read` | pr | – | | | §3.8 | B8a | **New**: a held problem returns only its `id` and `releaseStatus: held` (D90) |
| 283 | GET | `/portal/me/allergies` | V | Cl | `portal-records:read` | pr | – | | | §3.8 | B8a | **New** |
| 284 | GET | `/portal/me/allergies/{allergyId}` | V | Cl | `portal-records:read` | pr | – | | | §3.8 | B8a | **New** |
| 285 | GET | `/portal/me/vitals` | V | Cl | `portal-records:read` | pr | – | | | §3.8 | B8a | **New**: `type`, `dateFrom`, `dateTo`; units as entered (D69) |
| 286 | GET | `/patients/{patientId}/portal-account` | V | Ad | `portal-accounts:read` | pr | – | | | §3.8 | B8a | **New** (staff): account state and sign-in email, never a password, factor or code |
| 287 | POST | `/patients/{patientId}/portal-invitations` | V | Ad | `portal-invitations:create` | sec | – | | | §3.8 | B8a | **New** (staff): after an ID check; the code is in this response only (ADR-0013 §3) |
| 288 | POST | `/patients/{patientId}/portal-invitations/{invitationId}/revoke` | V | Ad | `portal-invitations:revoke` | sec | – | | | §3.8 | B8a | **New** (staff) |
| 289 | POST | `/patients/{patientId}/portal-account/reset-factors` | T | Ad | `portal-accounts:reset-factors` | sec | – | | | §3.8 | B8a | **New** (staff): after an ID check, never on a call or email (ADR-0013 §2) |
| 290 | POST | `/patients/{patientId}/portal-account/disable` | T | Ad | `portal-accounts:disable` | sec | – | | | §3.8 | B8a | **New** (staff, ADM; D92): reason required; ends every portal session at once |
| 291 | POST | `/patients/{patientId}/portal-account/enable` | T | Ad | `portal-accounts:enable` | sec | – | | | §3.8 | B8a | **New** (staff, ADM; D92): reason required |

**Ruled out by the decisions, with their replacements:**

| Her call | Why not | Instead |
|---|---|---|
| `POST /portal/registrations`, `POST /portal/registrations/summary` (11-page self-registration that the practice approves) | D85: no self-registration that links to a chart, and no name and date-of-birth matching | Front-desk invitation code after an ID check, then `POST /portal/enrollments`. The patient's history and details arrive afterwards as patient-reported data through `/portal/me/change-requests` and forms, for clinician review |
| `POST /portal/auth/username-reminder` `{ firstName, lastName, birthDate, email, postalCode, phone }` | D85: no lookup by name and date of birth; recovery belongs to the patient realm | The realm's own recovery, by verified email or phone, rate-limited, never revealing whether an account exists (ADR-0013 §4) |
| `POST /portal/auth/password-reset`, `POST /portal/me/password` | D3, D85: our API never handles patient passwords | The patient realm's reset and account pages |
| `POST /portal/auth/login` with a password in our API | D85: the realm signs in, with multi-factor | `GET /portal/auth/login` → the realm, then `/portal/auth/callback` |
| `GET /portal/patient-report/ccr` | CCR is a legacy format; we export C-CDA (FRS §3.9) | `POST /portal/me/record-exports` with `ccda` or `pdf` |
| A free 15/30/45/60-minute length when booking | Lengths come from appointment types (practice setup) | Choose an appointment type |
| Proxy access (switching to a family member) | D85: P2 | Not in the MVP portal |

