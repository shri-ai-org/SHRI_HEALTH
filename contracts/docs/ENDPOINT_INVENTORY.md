# Endpoint inventory and traceability

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** each module owner for their rows (VD-SIGN): Thulasi (platform, medications, orders), Anand (files, practice setup, billing, documents, C-CDA, inbox, exports), Minalini (communications, dashboard), Vimal (Vimal's modules and standards conformance of all rows).

This is the checklist for Stage 4: an endpoint is "done" when its contract exists with every field below. Source: CAT, changed only where a decision says so (last column). P1 endpoints and `/fhir` are excluded (VD-SCOPE).

## Column key

| Column | Meaning |
|---|---|
| Path | Under `/api/v1` unless marked `(root)`. Path parameters renamed to `{<resource>Id}` (API_STANDARDS §3) |
| Owner | `x-owner`: **V** Vimal, **T** Thulasi, **A** Anand, **M** Minalini |
| Store | DATA_OWNERSHIP §1: O ours, M mirrored, S signed-to-HAPI, H HAPI, B both, F files, C computed |
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

---

## 1. Platform — Thulasi

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/auth/login` | T | – | `public` | – | – | | | §6 Security | B1 | |
| 2 | GET | `/auth/callback` | T | O | `public` | sec | – | | | §6 | B1 | |
| 3 | POST | `/auth/refresh` | T | O | `authenticated` | sec | – | | | §6 | B1 | |
| 4 | POST | `/auth/logout` | T | O | `authenticated` | sec | – | | | §6 | B1 | Returns 204 (API_STANDARDS §4) |
| 5 | GET | `/auth/session` | T | O | `authenticated` | – | – | | | §6 | B1 | Returns `csrfToken` (SECURITY_MODEL §2.2, pending Thulasi) |
| 6 | GET | `/me` | T | O | `authenticated` | – | – | | | §3.10 | B1 | |
| 7 | GET | `/users` | T | O | `users:read` | adm | – | | | §3.10 | B1 | |
| 8 | POST | `/users` | T | O | `users:create` | adm | S | | | §3.10 | B1 | |
| 9 | GET | `/users/{userId}` | T | O | `users:read` | adm | – | | | §3.10 | B1 | |
| 10 | PATCH | `/users/{userId}` | T | O | `users:update` | adm | – | ✓ | | §3.10 | B1 | |
| 11 | GET | `/roles` | T | O | `roles:read` | – | – | | | §3.10 | B1 | |
| 12 | GET | `/users/{userId}/roles` | T | O | `roles:read` | adm | – | | | §3.10 | B1 | |
| 13 | PUT | `/users/{userId}/roles` | T | O | `user-roles:update` | sec | – | ✓ | | §3.10 | B1 | |
| 14 | GET | `/events/stream` | T | – | `authenticated` | – | – | | | FR-ORD-02, FR-SCH-02 | B1 | |
| 15 | GET | `/operations/{operationId}` | T | O | `authenticated` | – | – | | | — | B1 | **New** (API_STANDARDS §13), owner pending Thulasi |
| 16 | POST | `/operations/{operationId}/cancel` | T | O | `authenticated` | – | – | | | — | B1 | **New** |
| 17 | GET | `/audit-events` | T | O | `audit-events:read` | sec | – | | | §3.10, §6 Audit | B6 | |
| 18 | GET | `/reports/chart-access` | T | O | `chart-access-reports:read` | sec | – | | | §6 Sensitive records | B6 | |
| 19 | POST | `/patients/{patientId}/break-glass` | T | O | `patients:break-glass` | sec | S | | | FR-PAT-01 | B2 | |
| 20 | POST | `/hooks/clearinghouse` (root) | T | O+F | `partner-signed` | – | – | | | FR-RCM-01/02 | B6 | Moved outside `/api/v1` (API_STANDARDS §2, pending Thulasi) |
| 21 | POST | `/hooks/erx` (root) | T | O+F | `partner-signed` | – | – | | | FR-MED-01 | B5 | Same |
| 22 | POST | `/hooks/fax` (root) | T | O+F | `partner-signed` | – | – | | | §3.9 | B3 | Same |
| 23 | POST | `/hooks/sms` (root) | T | O+F | `partner-signed` | – | – | | | FR-SCH-01 reminders | B3 | Same |
| 24 | GET | `/admin/integration-messages` | T | O | `integration-messages:read` | adm | – | | | TA §7.1 | B6 | |
| 25 | POST | `/admin/integration-messages/{messageId}/replay` | T | O | `integration-messages:replay` | adm | S | | | TA §7.1 | B6 | |
| 26 | GET | `/health` (root) | T | – | `public` | – | – | | | §6 Availability | B1 | Outside `/api/v1` |
| 27 | GET | `/ready` (root) | T | – | `public` | – | – | | | §6 | B1 | Outside `/api/v1` |

## 2. Patients and insurance — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 28 | POST | `/patients/search` | V | M | `patients:search` | pr | – | | | FR-PAT-01 | B2 | **Was `GET /patients?search=`** (VD-G2) |
| 29 | POST | `/patients` | V | M | `patients:create` | pw | S | | | FR-PAT-01 | B2 | Duplicate check → `409 possible-duplicate` |
| 30 | GET | `/patients/{patientId}` | V | M | `patients:read` | pr | – | | | FR-PAT-01 | B2 | |
| 31 | PATCH | `/patients/{patientId}` | V | M | `patients:update` | pw | – | ✓ | | FR-PAT-01 | B2 | |
| 32 | GET | `/patients/{patientId}/identifiers` | V | M | `patients:read` | pr | – | | | FR-PAT-01 | B2 | |
| 33 | POST | `/patients/{patientId}/identifiers` | V | M | `patients:update` | pw | S | | | FR-PAT-01 (license scan) | B2 | |
| 34 | GET | `/patients/{patientId}/related-persons` | V | M | `patients:read` | pr | – | | | FR-PAT-01 (emergency contacts) | B2 | **New** (Stage 1 gap) |
| 35 | POST | `/patients/{patientId}/related-persons` | V | M | `patients:update` | pw | S | | | FR-PAT-01 | B2 | **New** |
| 36 | PATCH | `/patients/{patientId}/related-persons/{relatedPersonId}` | V | M | `patients:update` | pw | – | ✓ | | FR-PAT-01 | B2 | **New** |
| 37 | GET | `/patients/{patientId}/coverages` | V | O | `coverages:read` | pr | – | | | FR-PAT-01, FR-RCM-01 | B2 | |
| 38 | POST | `/patients/{patientId}/coverages` | V | O | `coverages:create` | pw | S | | | FR-RCM-01 | B2 | |
| 39 | PATCH | `/patients/{patientId}/coverages/{coverageId}` | V | O | `coverages:update` | pw | – | ✓ | | FR-RCM-01 | B2 | |
| 40 | POST | `/patients/{patientId}/coverages/{coverageId}/card-images` | V | O+F | `coverages:update` | pw | S | | | FR-PAT-01 | B2 | Body `{ fileId, side }` (API_STANDARDS §15) |
| 41 | GET | `/patients/{patientId}/consents` | V | O | `consents:read` | pr | – | | | FR-PAT-01 | B2 | |
| 42 | POST | `/patients/{patientId}/consents` | V | O | `consents:create` | pw | S | | | FR-PAT-01, AI-01 (recording consent) | B2 | |
| 43 | PUT | `/patients/{patientId}/preferred-pharmacy` | V | O | `patients:update` | pw | – | ✓ | | FR-PAT-01 | B2 | |
| 44 | POST | `/patients/{patientId}/restrict` | V | O | `patients:restrict` | sec | – | | | FR-PAT-01 | B2 | **New** (Stage 1 gap) |
| 45 | POST | `/patients/{patientId}/unrestrict` | V | O | `patients:restrict` | sec | – | | | FR-PAT-01 | B2 | **New** |
| 46 | GET | `/patients/{patientId}/timeline` | V | C | `timeline:read` | pr | – | | | FR-PAT-02 | B4 | Moved to B4 (reads clinical data) |
| 47 | GET | `/duplicates` | V | O | `duplicates:read` | pr | – | | | FR-PAT-01 | B2 | |
| 48 | POST | `/duplicates/{duplicateId}/merge` | V | O+M | `duplicates:merge` | pw | S | | | FR-PAT-01 | B2 | |
| 49 | POST | `/patient-merges/{mergeId}/undo` | V | O+M | `patient-merges:undo` | pw | S | | | FR-PAT-01 | B2 | |

## 3. Scheduling, check-in, eligibility — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 50 | GET | `/slots` | V | C | `slots:read` | – | – | | | FR-SCH-01 | B3 | Query `providerId`, `date`, `appointmentTypeId`, `facilityId` |
| 51 | POST | `/appointments` | V | O | `appointments:create` | pw | S | | | FR-SCH-01 | B3 | Also queues eligibility (VD-G3) |
| 52 | GET | `/appointments` | V | O | `appointments:read` | pr | – | | | FR-SCH-01 | B3 | Query `date`, `providerId`, `facilityId`, `patientId`, `status` |
| 53 | GET | `/appointments/{appointmentId}` | V | O | `appointments:read` | pr | – | | | FR-SCH-01 | B3 | **New** (single read missing from CAT) |
| 54 | PATCH | `/appointments/{appointmentId}` | V | O | `appointments:update` | pw | – | ✓ | | FR-SCH-01 | B3 | |
| 55 | POST | `/appointments/{appointmentId}/cancel` | V | O | `appointments:cancel` | pw | – | | | FR-SCH-01 | B3 | |
| 56 | POST | `/appointments/{appointmentId}/check-in` | V | O+B | `appointments:check-in` | pw | R | | | FR-SCH-02 | B3 | Creates Encounter (VD-G4); eligibility (VD-G3) — reaches a partner, so key required |
| 57 | POST | `/appointments/{appointmentId}/status` | V | O+B | `appointments:status` | pw | – | | | FR-SCH-02 | B3 | Values: `arrived`, `roomed`, `with-provider`, `checked-out`, `noshow` (DATA_OWNERSHIP §5.1) |
| 58 | GET | `/status-board` | V | C | `status-board:read` | pr | – | | | FR-SCH-02 | B3 | |
| 59 | POST | `/eligibility-checks` | V | O | `eligibility-checks:create` | pw | R | | ✓ | FR-RCM-01 | B3 | |
| 60 | GET | `/eligibility-checks/{eligibilityCheckId}` | V | O | `eligibility-checks:read` | pr | – | | | FR-RCM-01 | B3 | |
| 61 | GET | `/appointments/{appointmentId}/eligibility-checks` | V | O | `eligibility-checks:read` | pr | – | | | FR-RCM-01 | B3 | **New** (Stage 1 gap) |

## 4. Encounters and notes — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 62 | POST | `/encounters` | V | B | `encounters:create` | pw | S | | | FR-ENC-01 | B4 | Unscheduled encounters only (VD-G4) |
| 63 | GET | `/encounters/{encounterId}` | V | B+H | `encounters:read` | pr | – | | | FR-ENC-01 | B4 | Workspace data |
| 64 | PATCH | `/encounters/{encounterId}` | V | B | `encounters:update` | pw | – | ✓ | | FR-ENC-01 | B4 | |
| 65 | GET | `/patients/{patientId}/encounters` | V | B | `encounters:read` | pr | – | | | FR-PAT-02 | B4 | **New** (Stage 1 gap) |
| 66 | POST | `/encounters/{encounterId}/close` | V | B | `encounters:close` | pw | – | | | FR-ENC-01 | B4 | Publishes `encounter.closed` |
| 67 | POST | `/encounters/{encounterId}/entered-in-error` | V | B | `encounters:entered-in-error` | pw | – | | | FR-ENC-01 | B4 | **New** (VD-G6 pattern) |
| 68 | POST | `/encounters/{encounterId}/vitals` | V | H | `vitals:create` | pw | S | | | FR-ENC-03, FR-SCH-02 | B4 | |
| 69 | GET | `/patients/{patientId}/vitals` | V | H | `vitals:read` | pr | – | | | FR-ENC-03 | B4 | |
| 70 | POST | `/patients/{patientId}/vitals/{vitalId}/entered-in-error` | V | H | `vitals:entered-in-error` | pw | – | | | FR-ENC-03 | B4 | **New** (VD-G6) |
| 71 | POST | `/encounters/{encounterId}/diagnoses` | V | S (draft in ours; HAPI on signing, DATA_OWNERSHIP §2.5) | `diagnoses:create` | pw | S | | | FR-ENC-02 | B4 | |
| 72 | POST | `/encounters/{encounterId}/diagnoses/{diagnosisId}/remove` | V | S (draft row only) | `diagnoses:remove` | pw | – | | | FR-ENC-02 | B4 | **Was `DELETE`** (VD-G1); only while unsigned |
| 73 | POST | `/encounters/{encounterId}/diagnoses/{diagnosisId}/entered-in-error` | V | H (after signing) | `diagnoses:entered-in-error` | pw | – | | | FR-ENC-02 | B4 | **New** (VD-G1, VD-G6); after signing |
| 74 | GET | `/codes/search` | V | O | `codes:read` | – | – | | | FR-ENC-02 | B4 | Query `system`, `q` (reference data, not PHI) |
| 75 | POST | `/encounters/{encounterId}/notes` | V | S | `notes:create` | pw | S | | | FR-ENC-01, FR-ENC-04 | B4 | |
| 76 | GET | `/encounters/{encounterId}/notes` | V | S | `notes:read` | pr | – | | | FR-ENC-01 | B4 | **New** (Stage 1 gap) |
| 77 | GET | `/notes/{noteId}` | V | S | `notes:read` | pr | – | | | FR-ENC-01 | B4 | **New** (Stage 1 gap) |
| 78 | PATCH | `/notes/{noteId}` | V | S | `notes:update` | pw | – | ✓ | | FR-ENC-01 | B4 | Autosave |
| 79 | POST | `/notes/{noteId}/sign` | V | S | `notes:sign` | sg | – | ✓ | | FR-ENC-01, AI §3.4 | B4 | Guard: every AI suggestion decided |
| 80 | POST | `/notes/{noteId}/addenda` | V | S | `note-addenda:create` | sg | S | ✓ | | FR-ENC-01 | B4 | |
| 81 | POST | `/notes/{noteId}/cosign` | V | S | `notes:cosign` | sg | – | ✓ | | FR-ENC-01 | B4 | |
| 82 | GET | `/notes/{noteId}/versions` | V | S | `notes:read` | pr | – | | | FR-ENC-01 | B4 | |
| 83 | POST | `/notes/{noteId}/entered-in-error` | V | S | `notes:entered-in-error` | pw | – | | | FR-ENC-01 | B4 | **New** (VD-G6) |
| 84 | GET | `/me/favorites` | V | O | `favorites:read` | – | – | | | FR-ENC-04 | B4 | **Was `/me/favourites`** (VD-G9) |
| 85 | PUT | `/me/favorites` | V | O | `favorites:update` | – | – | ✓ | | FR-ENC-04 | B4 | Same |
| 86 | POST | `/encounters/{encounterId}/after-visit-summary` | V | F+O | `after-visit-summaries:create` | ex | S | | ✓ | FR-ENC-06 | B4 | Async PDF |
| 87 | GET | `/cosign-rules` | V | O | `cosign-rules:read` | adm | – | | | FR-ENC-01 (co-signature by state and provider) | B4 | **New** (Stage 1 gap); owner pending Anand agreement |
| 88 | POST | `/cosign-rules` | V | O | `cosign-rules:create` | adm | S | | | FR-ENC-01 | B4 | **New** |
| 89 | PATCH | `/cosign-rules/{cosignRuleId}` | V | O | `cosign-rules:update` | adm | – | ✓ | | FR-ENC-01 | B4 | **New** |

## 5. Patient history — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 90 | GET | `/patients/{patientId}/problems` | V | H | `problems:read` | pr | – | | | FR-PAT-03 | B4 | |
| 91 | POST | `/patients/{patientId}/problems` | V | H | `problems:create` | pw | S | | | FR-PAT-03 | B4 | |
| 92 | PATCH | `/patients/{patientId}/problems/{problemId}` | V | H | `problems:update` | pw | – | ✓ | | FR-PAT-03 | B4 | |
| 93 | POST | `/patients/{patientId}/problems/{problemId}/entered-in-error` | V | H | `problems:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | **Replaces generic `/records/{type}/{rid}/entered-in-error`** (VD-G6) |
| 94 | GET | `/patients/{patientId}/allergies` | V | H | `allergies:read` | pr | – | | | FR-PAT-03, FR-MED-01 | B4 | |
| 95 | POST | `/patients/{patientId}/allergies` | V | H | `allergies:create` | pw | S | | | FR-PAT-03 | B4 | |
| 96 | PATCH | `/patients/{patientId}/allergies/{allergyId}` | V | H | `allergies:update` | pw | – | ✓ | | FR-PAT-03 | B4 | |
| 97 | POST | `/patients/{patientId}/allergies/{allergyId}/entered-in-error` | V | H | `allergies:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |
| 98 | GET | `/patients/{patientId}/family-history` | V | H | `family-history:read` | pr | – | | | FR-PAT-03 | B4 | |
| 99 | POST | `/patients/{patientId}/family-history` | V | H | `family-history:create` | pw | S | | | FR-PAT-03 | B4 | |
| 100 | POST | `/patients/{patientId}/family-history/{familyHistoryId}/entered-in-error` | V | H | `family-history:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |
| 101 | GET | `/patients/{patientId}/social-history` | V | H | `social-history:read` | pr | – | | | FR-PAT-03 | B4 | |
| 102 | POST | `/patients/{patientId}/social-history` | V | H | `social-history:create` | pw | S | | | FR-PAT-03 (smoking status) | B4 | |
| 103 | POST | `/patients/{patientId}/social-history/{socialHistoryId}/entered-in-error` | V | H | `social-history:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |
| 104 | GET | `/patients/{patientId}/surgical-history` | V | H | `surgical-history:read` | pr | – | | | FR-PAT-03 | B4 | |
| 105 | POST | `/patients/{patientId}/surgical-history` | V | H | `surgical-history:create` | pw | S | | | FR-PAT-03 | B4 | |
| 106 | POST | `/patients/{patientId}/surgical-history/{surgicalHistoryId}/entered-in-error` | V | H | `surgical-history:entered-in-error` | pw | – | | | FR-PAT-03 | B4 | VD-G6 |

## 6. AI — Vimal

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 107 | POST | `/encounters/{encounterId}/audio` | V | F+O | `encounter-audio:create` | ai | S | | | AI-01 (incl. uploaded audio) | B7 | Body references `fileId`s; recording consent checked |
| 108 | POST | `/ai/transcriptions` | V | O | `transcriptions:create` | ai | S | | ✓ | AI-01 | B7 | |
| 109 | GET | `/ai/transcriptions/{transcriptionId}` | V | O | `transcriptions:read` | pr | – | | | AI-01 | B7 | |
| 110 | POST | `/ai/note-drafts` | V | O→S | `note-drafts:create` | ai | S | | ✓ | AI-01 | B7 | Result is a draft note (VD-G11) |
| 111 | POST | `/ai/chart-summaries` | V | O | `chart-summaries:create` | ai | S | | ✓ | AI-02 | B7 | |
| 112 | GET | `/ai/chart-summaries/{chartSummaryId}` | V | O | `chart-summaries:read` | pr | – | | | AI-02 | B7 | **New** (result of the operation) |
| 113 | POST | `/ai/suggestions/{suggestionId}/decision` | V | O | `ai-suggestions:decision` | ai | S | | | §3.4 traceability | B7 | |
| 114 | GET | `/admin/ai-settings` | V | O | `ai-settings:read` | adm | – | | | §3.4 kill switch, §3.10 | B7 | |
| 115 | PUT | `/admin/ai-settings` | V | O | `ai-settings:update` | adm | – | ✓ | | §3.4 | B7 | |

## 7. Medications and prescriptions — Thulasi

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 116 | GET | `/patients/{patientId}/medications` | T | H | `medications:read` | pr | – | | | FR-MED-01 | B5 | |
| 117 | POST | `/patients/{patientId}/medications` | T | H | `medications:create` | pw | S | | | FR-MED-01 | B5 | |
| 118 | POST | `/medications/{medicationId}/discontinue` | T | H | `medications:discontinue` | pw | – | | | FR-MED-01 | B5 | |
| 119 | POST | `/patients/{patientId}/medication-reconciliation` | T | H | `medication-reconciliations:create` | pw | S | | | FR-MED-01, FR-SCH-02 rooming | B5 | |
| 120 | POST | `/prescriptions` | T | S | `prescriptions:create` | pw | S | | | FR-MED-01 | B5 | |
| 121 | GET | `/prescriptions/{prescriptionId}` | T | S | `prescriptions:read` | pr | – | | | FR-MED-01 | B5 | **New, pending Thulasi** (missing from CAT) |
| 122 | PATCH | `/prescriptions/{prescriptionId}` | T | S | `prescriptions:update` | pw | – | ✓ | | FR-MED-01 | B5 | **New, pending Thulasi** (VG Step 1 requires If-Match on prescription updates) |
| 123 | POST | `/prescriptions/{prescriptionId}/safety-check` | T | O | `prescriptions:safety-check` | pw | – | | | FR-MED-01, §3.4 CDS layer 1 | B5 | |
| 124 | POST | `/alerts/{alertId}/override` | T | O | `alerts:override` | pw | – | | | §3.4 | B5 | |
| 125 | POST | `/prescriptions/{prescriptionId}/sign-and-send` | T | S | `prescriptions:sign-and-send` | sg | R | ✓ | | FR-MED-01 | B5 | |
| 126 | POST | `/prescriptions/{prescriptionId}/cancel` | T | S | `prescriptions:cancel` | pw | R | | | FR-MED-01 | B5 | |
| 127 | POST | `/prescriptions/{prescriptionId}/change` | T | S | `prescriptions:change` | sg | R | ✓ | | FR-MED-01 | B5 | |
| 128 | GET | `/refill-requests` | T | O | `refill-requests:read` | pr | – | | | FR-MED-01, FR-ENC-05 | B5 | |
| 129 | POST | `/refill-requests/{refillRequestId}/respond` | T | O+S | `refill-requests:respond` | sg | R | | | FR-MED-01 | B5 | |
| 130 | GET | `/pharmacies` | T | O | `pharmacies:read` | – | – | | | FR-PAT-01, FR-MED-01 | B5 | Query `q`, `postalCode` (pharmacy data, not PHI) |
| 131 | POST | `/patients/{patientId}/medication-history/fetch` | T | H | `medication-history:fetch` | pr | R | | ✓ | FR-MED-01 | B5 | |

## 8. Orders and results — Thulasi

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 132 | GET | `/lab-compendium` | T | O | `lab-compendium:read` | – | – | | | FR-ORD-01 | B5 | Query `labId`, `q` |
| 133 | GET | `/lab-compendium/{testId}/questions` | T | O | `lab-compendium:read` | – | – | | | FR-ORD-01 (AOE) | B5 | |
| 134 | POST | `/orders` | T | S | `orders:create` | pw | S | | | FR-ORD-01 | B5 | |
| 135 | GET | `/orders` | T | S | `orders:read` | pr | – | | | FR-ORD-01 | B5 | Query `patientId`, `status` |
| 136 | GET | `/orders/{orderId}` | T | S | `orders:read` | pr | – | | | FR-ORD-01 | B5 | **New, pending Thulasi** |
| 137 | POST | `/orders/{orderId}/medical-necessity-check` | T | O | `orders:medical-necessity-check` | pw | – | | | FR-ORD-01 (ABN) | B5 | |
| 138 | POST | `/orders/{orderId}/sign-and-send` | T | S | `orders:sign-and-send` | sg | R | ✓ | | FR-ORD-01 | B5 | |
| 139 | POST | `/orders/{orderId}/cancel` | T | S | `orders:cancel` | pw | R | | | FR-ORD-01 | B5 | |
| 140 | GET | `/orders/{orderId}/requisition` | T | F | `orders:read` | ex | – | | | FR-ORD-01 | B5 | **Pending Thulasi:** return a file download link, not PDF bytes (API_STANDARDS §15) |
| 141 | GET | `/orders/{orderId}/labels` | T | F | `orders:read` | ex | – | | | FR-ORD-01 | B5 | Same |
| 142 | GET | `/results` | T | H | `results:read` | pr | – | | | FR-ORD-02 | B5 | Query `unreviewed`, `patientId` |
| 143 | GET | `/results/{resultId}` | T | H | `results:read` | pr | – | | | FR-ORD-02 | B5 | |
| 144 | POST | `/results/{resultId}/acknowledge` | T | O | `results:acknowledge` | pw | – | | | FR-ORD-02 | B5 | |
| 145 | GET | `/unmatched-results` | T | O | `unmatched-results:read` | pr | – | | | FR-ORD-02 | B5 | |
| 146 | POST | `/unmatched-results/{unmatchedResultId}/match` | T | O+H | `unmatched-results:match` | pw | – | | | FR-ORD-02 | B5 | |
| 147 | POST | `/encounters/{encounterId}/in-office-results` | T | H | `in-office-results:create` | pw | S | | | FR-ORD-02 | B5 | |

## 9. Files, practice setup, billing, documents, inbox, exports — Anand

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 148 | POST | `/files/upload-url` | A | F | `files:create` | pw | S | | | §3.9 | B1 | |
| 149 | POST | `/files/{fileId}/complete` | A | F | `files:create` | pw | – | | ✓ | §3.9, TA §9 scan | B1 | Scan is async |
| 150 | GET | `/files/{fileId}/download-url` | A | F | `files:read` | ex | – | | | §3.9 | B1 | Plus purpose-based check |
| 151–154 | GET, POST, GET `{facilityId}`, PATCH `{facilityId}` | `/facilities` | A | M | `practice-setup:read\|create\|update` | adm | S on POST | ✓ on PATCH | | §3.10 | B1 | Single GET added |
| 155–158 | same 4 | `/locations` | A | M | same | adm | S | ✓ | | §3.10 | B1 | Same |
| 159–162 | same 4 | `/providers` | A | M | same | adm | S | ✓ | | §3.10 (NPIs) | B1 | Same |
| 163–166 | same 4 | `/appointment-types` | A | O | same | adm | S | ✓ | | FR-SCH-01 | B1 | Same |
| 167–170 | same 4 | `/provider-schedules` | A | O | same | adm | S | ✓ | | FR-SCH-01 | B1 | Same |
| 171–174 | same 4 | `/fee-schedules` | A | O | same | adm | S | ✓ | | FR-RCM-02 | B1 | Same |
| 175–178 | same 4 | `/payers` | A | O | same | adm | S | ✓ | | FR-RCM-01 | B1 | Same |
| 179–182 | same 4 | `/lab-accounts` | A | O | same | adm | S | ✓ | | FR-ORD-01 | B1 | Same |
| 183–186 | same 4 | `/note-templates` | A | O | same | adm | S | ✓ | | FR-ENC-04 | B1 | Same |
| 187 | POST | `/onboarding/import` | A | O+F | `onboarding:import` | adm | S | | ✓ | §3.10 onboarding | B1 | |
| 188 | GET | `/encounters/{encounterId}/superbill` | A | O | `superbills:read` | pr | – | | | FR-RCM-02 | B6 | |
| 189 | PATCH | `/encounters/{encounterId}/superbill` | A | O | `superbills:update` | pw | – | ✓ | | FR-RCM-02 | B6 | |
| 190 | POST | `/claims` | A | O | `claims:create` | pw | S | | | FR-RCM-02 | B6 | |
| 191 | GET | `/claims` | A | O | `claims:read` | pr | – | | | FR-RCM-02 | B6 | Query `status` |
| 192 | GET | `/claims/{claimId}` | A | O | `claims:read` | pr | – | | | FR-RCM-02 | B6 | |
| 193 | POST | `/claims/{claimId}/scrub` | A | O | `claims:scrub` | pw | – | | | FR-RCM-02 | B6 | |
| 194 | POST | `/claims/{claimId}/submit` | A | O | `claims:submit` | pw | R | | | FR-RCM-02 | B6 | |
| 195 | POST | `/claims/{claimId}/status-check` | A | O | `claims:status-check` | pr | R | | | FR-RCM-02 | B6 | |
| 196 | POST | `/claims/{claimId}/correct` | A | O | `claims:correct` | pw | R | | | FR-RCM-02 | B6 | |
| 197 | POST | `/claims/{claimId}/void` | A | O | `claims:void` | pw | R | | | FR-RCM-02 | B6 | |
| 198 | POST | `/patients/{patientId}/payments` | A | O | `payments:create` | pw | R | | | FR-RCM-03, FR-SCH-02 copay | B3 | Charges money |
| 199 | POST | `/payments/card-session` | A | O | `payments:card-session` | pw | R | | | FR-RCM-03 | B3 | |
| 200 | GET | `/remittances` | A | O | `remittances:read` | pr | – | | | FR-RCM-03 | B6 | |
| 201 | POST | `/remittances/{remittanceId}/post` | A | O | `remittances:post` | pw | S | | | FR-RCM-03 (P0 stretch) | B6 | |
| 202 | GET | `/reports/ar-aging` | A | C | `billing-reports:read` | pr | – | | | FR-RCM-03 | B6 | |
| 203 | GET | `/reports/charges-payments` | A | C | `billing-reports:read` | pr | – | | | FR-RCM-03 | B6 | |
| 204 | GET | `/documents` | A | O+F | `documents:read` | pr | – | | | §3.9 | B3 | |
| 205 | GET | `/patients/{patientId}/documents` | A | O+F | `documents:read` | pr | – | | | §3.9 | B3 | |
| 206 | POST | `/documents` | A | O+F | `documents:create` | pw | S | | | §3.9 | B3 | |
| 207 | GET | `/documents/{documentId}` | A | O+F | `documents:read` | pr | – | | | §3.9 | B3 | Single GET implied by CAT |
| 208 | PATCH | `/documents/{documentId}` | A | O+F | `documents:update` | pw | – | ✓ | | §3.9 | B3 | |
| 209 | POST | `/faxes` | A | O+F | `faxes:create` | ex | R | | | §3.9 | B3 | Reaches a partner |
| 210 | GET | `/fax-inbox` | A | O+F | `fax-inbox:read` | pr | – | | | §3.9 | B3 | |
| 211 | POST | `/fax-inbox/{faxId}/file` | A | O+F | `fax-inbox:file` | pw | – | | | §3.9 | B3 | |
| 212 | POST | `/ccda/import` | A | F+O | `ccda:import` | pw | S | | ✓ | §3.9 | B6 | |
| 213 | GET | `/patients/{patientId}/ccda` | A | F | `ccda:export` | ex | – | | | §3.9 | B6 | **Pending Anand:** if generation is slow, change to `POST /patients/{patientId}/ccda-exports` → 202 (API_STANDARDS §13) |
| 214 | GET | `/inbox` | A | O | `inbox:read` | pr | – | | | FR-ENC-05 | B3 | |
| 215 | PATCH | `/inbox/{inboxItemId}` | A | O | `inbox:update` | pw | – | ✓ | | FR-ENC-05 | B3 | |
| 216 | POST | `/inbox/{inboxItemId}/complete` | A | O | `inbox:complete` | pw | – | | | FR-ENC-05 | B3 | |
| 217 | POST | `/messages` | A | O | `messages:create` | pw | S | | | FR-ENC-05 | B3 | |
| 218 | POST | `/exports` | A | O+F | `exports:create` | ex | S | | ✓ | §3.10 | B6 | |
| 219 | GET | `/exports/{exportId}` | A | O+F | `exports:read` | ex | – | | | §3.10 | B6 | |

## 10. Communications and dashboard — Minalini

| # | Method | Path | Owner | Store | Permission | Audit | Idem | IfM | 202 | FRS | B | Change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 220 | GET | `/message-templates` | M | O | `message-templates:read` | – | – | | | §3.9 | B3 | |
| 221 | POST | `/message-templates` | M | O | `message-templates:create` | adm | S | | | §3.9 | B3 | |
| 222 | PATCH | `/message-templates/{messageTemplateId}` | M | O | `message-templates:update` | adm | – | ✓ | | §3.9 | B3 | |
| 223 | GET | `/patients/{patientId}/communication-preferences` | M | O | `communication-preferences:read` | pr | – | | | §3.9 | B3 | |
| 224 | PUT | `/patients/{patientId}/communication-preferences` | M | O | `communication-preferences:update` | pw | – | ✓ | | §3.9 | B3 | |
| 225 | GET | `/patients/{patientId}/communications` | M | O | `communications:read` | pr | – | | | §3.9 | B3 | |
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
| Proposed to owners | #121–122 (Thulasi), #136 (Thulasi), single GETs in practice setup and documents (Anand), #140–141 return links (Thulasi), #213 async export (Anand) | Pending owners |
| Moved outside `/api/v1` | `/hooks/*`, `/health`, `/ready` | API_STANDARDS §2, pending Thulasi |

Also proposed but not yet listed as rows (waiting for the owner): `POST /prescriptions/{prescriptionId}/entered-in-error` (drafts), `POST /unmatched-results/{unmatchedResultId}/reject` (Thulasi, DATA_OWNERSHIP §5.4, §5.6).

**Count:** 226 operations (27 platform, 22 patients, 12 scheduling and eligibility, 28 encounters and notes, 17 history, 9 AI, 16 medications, 16 orders, 72 Anand, 7 Minalini). Recounted when the contract is written.
