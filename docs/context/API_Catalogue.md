# Shri Health — API Catalogue (MVP)

Every endpoint the screens and partners call, grouped by owner. Vimal turns this into the contract in `contracts/openapi/` (one file per module plus shared components, bundled for tools; D17); the contract then becomes the source of truth and this file is kept only as an overview. The endpoint list follows `contracts/docs/ENDPOINT_INVENTORY.md`, and the **#** column gives each row's inventory number. Where this file and the inventory differ, the inventory wins.

**Conventions:** base path `/api/v1`, except `/hooks/*` and `/health`, which sit outside it. GET reads, POST creates or runs an action (`POST /x/{id}/action`), PATCH/PUT changes. **No DELETE anywhere** (D14): a mistake is marked through one entered-in-error action per resource type, each with its own permission. **No PHI in URLs** (D13): opaque UUIDs only; PHI searches use `POST …/search` with a body. U.S. spelling in every identifier and description (D18). Every endpoint has an `x-permission`. POSTs that reach a partner or move money take an `Idempotency-Key` header (ADR-0007). Every PATCH and PUT, and the sign actions, require `If-Match` (ADR-0008). Long-running work returns `202` and an operation.

**Storage:** everything is in our one PostgreSQL database (ADR-0011). *Ours (clinical)* = FHIR-shaped clinical tables; *Ours (admin)* = normalized admin tables; *computed* = assembled at request time; *+ files* = file storage, with only the file ID in the database. There is no HAPI.

## Thulasi — platform and security

| # | Method | Path | Purpose |
|---|---|---|---|
| 1–2 | GET | `/auth/login`, `/auth/callback` | Login with Keycloak (code + PKCE); session cookie holds a reference token |
| 3–4 | POST | `/auth/refresh`, `/auth/logout` | Refresh and revoke the session |
| 5–6 | GET | `/auth/session`, `/me` | Session state (CSRF token, idle and absolute expiry); current user, roles, clinic |
| 7–10 | GET, POST, GET, PATCH | `/users`, `/users/{userId}` | Staff accounts, synced with Keycloak |
| 11–13 | GET, GET, PUT | `/roles`, `/users/{userId}/roles` | Roles and role assignment |
| 14 | GET | `/events/stream` | Live updates (Server-Sent Events) |
| 15–16 | GET, POST | `/operations/{operationId}`, `/operations/{operationId}/cancel` | Status and cancellation of long-running work |
| 17–18 | GET | `/audit-events`, `/reports/chart-access` | Audit search; who opened a chart |
| 19 | POST | `/patients/{patientId}/break-glass` | Open a restricted chart with a reason |
| 20–23 | POST | `/hooks/clearinghouse`, `/hooks/erx`, `/hooks/fax`, `/hooks/sms` (outside `/api/v1`) | Partner callbacks (signature-checked) |
| 24–25 | GET, POST | `/admin/integration-messages`, `/admin/integration-messages/{messageId}/replay` | Partner message log; replay failures |
| 26 | GET | `/health` (outside `/api/v1`) | Server check, public through Nginx. `/ready` is internal only and not in the contract (#27) |

## Vimal — front desk, encounters, history, AI

### Patients and insurance (Ours (clinical): Patient, RelatedPerson, Coverage, Consent; Ours (admin): preferred pharmacy, duplicates and merges)

| # | Method | Path | Purpose |
|---|---|---|---|
| 28 | POST | `/patients/search` | Search by name, date of birth, phone, MRN; criteria in the body, never in the URL (D13) |
| 29 | POST | `/patients` | Register, with a duplicate check |
| 30–31 | GET, PATCH | `/patients/{patientId}` | View or edit demographics |
| 32–33 | GET, POST | `/patients/{patientId}/identifiers` | MRN, license number, other IDs |
| 34–36 | GET, POST, PATCH | `/patients/{patientId}/related-persons`, `/patients/{patientId}/related-persons/{relatedPersonId}` | Emergency contacts, guarantors, subscribers |
| 37–39 | GET, POST, PATCH | `/patients/{patientId}/coverages`, `/patients/{patientId}/coverages/{coverageId}` | Insurance, primary and secondary |
| 40 | POST | `/patients/{patientId}/coverages/{coverageId}/card-images` | Card photos (file ID from the file service; also files) |
| 41–42 | GET, POST | `/patients/{patientId}/consents` | Consents and privacy notice |
| 43 | PUT | `/patients/{patientId}/preferred-pharmacy` | Preferred pharmacy |
| 44–45 | POST | `/patients/{patientId}/restrict`, `/patients/{patientId}/unrestrict` | Mark a chart restricted, or lift it |
| 46 | GET | `/patients/{patientId}/timeline` | Longitudinal record (computed) |
| 47 | GET | `/duplicates` | Possible duplicates |
| 48–49 | POST | `/duplicates/{duplicateId}/merge`, `/patient-merges/{mergeId}/undo` | Merge and undo |

### Scheduling and check-in (Ours (clinical): Appointment, Schedule, Encounter created at check-in; Ours (admin): appointment types, availability, visit flow)

| # | Method | Path | Purpose |
|---|---|---|---|
| 50 | GET | `/slots?providerId=&date=&appointmentTypeId=&facilityId=` | Free times (computed) |
| 51 | POST | `/appointments` | Book, including same-day add-on; also queues eligibility (D15) |
| 52 | GET | `/appointments?date=&providerId=&facilityId=&patientId=&status=` | Day and week views |
| 53–54 | GET, PATCH | `/appointments/{appointmentId}` | View; reschedule |
| 55 | POST | `/appointments/{appointmentId}/cancel` | Cancel with reason |
| 56 | POST | `/appointments/{appointmentId}/check-in` | Check in; creates the Encounter (D16) and runs eligibility (D15) |
| 57 | POST | `/appointments/{appointmentId}/status` | Arrived, roomed, with provider, checked out, no-show |
| 58 | GET | `/status-board` | Today's clinic flow (computed) |

### Eligibility (Ours (admin))

| # | Method | Path | Purpose |
|---|---|---|---|
| 59 | POST | `/eligibility-checks` | Run a 270/271 check through the integration engine (`202`) |
| 60 | GET | `/eligibility-checks/{eligibilityCheckId}` | Result: coverage, copay, deductible |
| 61 | GET | `/appointments/{appointmentId}/eligibility-checks` | Checks for one appointment (at booking, pre-visit batch and check-in, D15) |

### Encounters and notes (Ours (clinical): Encounter, vitals, diagnoses, notes from draft to signed, Provenance; Ours (admin): favorites, templates, co-sign rules, code tables)

| # | Method | Path | Purpose |
|---|---|---|---|
| 62 | POST | `/encounters` | Open an unscheduled visit (telephone, documentation-only); scheduled visits start at check-in (D16) |
| 63–64 | GET, PATCH | `/encounters/{encounterId}` | Workspace data; update |
| 65 | GET | `/patients/{patientId}/encounters` | A patient's visits |
| 66 | POST | `/encounters/{encounterId}/close` | Close; publishes `encounter.closed` for billing |
| 67 | POST | `/encounters/{encounterId}/entered-in-error` | Mark a visit wrong |
| 68 | POST | `/encounters/{encounterId}/vitals` | Record vitals |
| 69 | GET | `/patients/{patientId}/vitals` | Vitals trend |
| 70 | POST | `/patients/{patientId}/vitals/{vitalId}/entered-in-error` | Mark a vital sign wrong |
| 71 | POST | `/encounters/{encounterId}/diagnoses` | Add a diagnosis |
| 72 | POST | `/encounters/{encounterId}/diagnoses/{diagnosisId}/remove` | Remove before signing: sets entered-in-error with a reason and a Provenance record (D14, D24) |
| 73 | POST | `/encounters/{encounterId}/diagnoses/{diagnosisId}/entered-in-error` | Mark a diagnosis wrong after signing |
| 74 | GET | `/codes/search?system=&q=` | ICD-10, CPT, RxNorm, LOINC search (reference data, not PHI) |
| 75–76 | POST, GET | `/encounters/{encounterId}/notes` | Start a note from a template; list a visit's notes |
| 77–78 | GET, PATCH | `/notes/{noteId}` | View; autosave draft (If-Match) |
| 79 | POST | `/notes/{noteId}/sign` | Sign; locks the note |
| 80 | POST | `/notes/{noteId}/addenda` | Addendum to a signed note |
| 81 | POST | `/notes/{noteId}/cosign` | Supervising co-signature |
| 82 | GET | `/notes/{noteId}/versions` | History |
| 83 | POST | `/notes/{noteId}/entered-in-error` | Mark a note wrong |
| 84–85 | GET, PUT | `/me/favorites` | Favorite templates, diagnoses, orders, phrases |
| 86 | POST | `/encounters/{encounterId}/after-visit-summary` | Patient handout PDF (`202`; also files) |
| 87–89 | GET, POST, PATCH | `/cosign-rules`, `/cosign-rules/{cosignRuleId}` | Co-signature rules by state and provider |

### Patient history (Ours (clinical))

Each history type has its own entered-in-error action with its own permission; there is no generic `/records/…` endpoint (D14).

| # | Method | Path | Purpose |
|---|---|---|---|
| 90–93 | GET, POST, PATCH, POST | `/patients/{patientId}/problems`, `/patients/{patientId}/problems/{problemId}`, `/patients/{patientId}/problems/{problemId}/entered-in-error` | Problem list (Condition) |
| 94–97 | GET, POST, PATCH, POST | `/patients/{patientId}/allergies`, `/patients/{patientId}/allergies/{allergyId}`, `/patients/{patientId}/allergies/{allergyId}/entered-in-error` | AllergyIntolerance |
| 98–100 | GET, POST, POST | `/patients/{patientId}/family-history`, `/patients/{patientId}/family-history/{familyHistoryId}/entered-in-error` | FamilyMemberHistory |
| 101–103 | GET, POST, POST | `/patients/{patientId}/social-history`, `/patients/{patientId}/social-history/{socialHistoryId}/entered-in-error` | Observation, social-history category |
| 104–106 | GET, POST, POST | `/patients/{patientId}/surgical-history`, `/patients/{patientId}/surgical-history/{surgicalHistoryId}/entered-in-error` | Procedure |

### AI (Ours (admin): requests, audio, transcripts and review logs)

| # | Method | Path | Purpose |
|---|---|---|---|
| 107 | POST | `/encounters/{encounterId}/audio` | Recording (chunked upload via the file service; also files) |
| 108–109 | POST, GET | `/ai/transcriptions`, `/ai/transcriptions/{transcriptionId}` | Speech to text (`202`) and its status |
| 110 | POST | `/ai/note-drafts` | Transcript to draft note (AI-01; `202`; the result is a draft note) |
| 111–112 | POST, GET | `/ai/chart-summaries`, `/ai/chart-summaries/{chartSummaryId}` | Chart summary with source links (AI-02; `202`) and its result |
| 113 | POST | `/ai/suggestions/{suggestionId}/decision` | Accept, edit or reject |
| 114–115 | GET, PUT | `/admin/ai-settings` | AI on/off switches |

## Thulasi — clinical: medications and orders

### Medications and prescriptions (Ours (clinical): MedicationRequest from draft to signed, also the medication list (D28), MedicationDispense, safety alerts; Ours (admin): pharmacy directory, e-prescribing transactions, refill requests. MedicationStatement is P1, D28)

| # | Method | Path | Purpose |
|---|---|---|---|
| 116–117 | GET, POST | `/patients/{patientId}/medications` | Medication list |
| 118 | POST | `/medications/{medicationId}/discontinue` | Stop, with reason |
| 119 | POST | `/patients/{patientId}/medication-reconciliation` | Confirm list |
| 120 | POST | `/prescriptions` | Draft |
| 121–122 | GET, PATCH | `/prescriptions/{prescriptionId}` | View; edit a draft (a signed prescription is locked) |
| 227 | POST | `/prescriptions/{prescriptionId}/entered-in-error` | Mark a draft wrong; anything already sent uses cancel |
| 123 | POST | `/prescriptions/{prescriptionId}/safety-check` | Allergy, interaction, duplicate, dose rules |
| 124 | POST | `/alerts/{alertId}/override` | Override with reason |
| 125 | POST | `/prescriptions/{prescriptionId}/sign-and-send` | Sign and send to e-prescribing vendor |
| 126–127 | POST | `/prescriptions/{prescriptionId}/cancel`, `/prescriptions/{prescriptionId}/change` | Cancel or change |
| 128–129 | GET, POST | `/refill-requests`, `/refill-requests/{refillRequestId}/respond` | Pharmacy renewal and change requests |
| 130 | GET | `/pharmacies?q=&postalCode=` | Pharmacy directory (not PHI) |
| 131 | POST | `/patients/{patientId}/medication-history/fetch` | Outside prescription history (`202`) |

### Orders and results (Ours (clinical): ServiceRequest, Specimen, DiagnosticReport, Observation; Ours (admin): compendium, medical-necessity checks, acknowledgements, status history, unmatched queue)

| # | Method | Path | Purpose |
|---|---|---|---|
| 132–133 | GET | `/lab-compendium?labId=&q=`, `/lab-compendium/{testId}/questions` | Test search; ask-at-order questions |
| 134 | POST | `/orders` | Draft order |
| 135–136 | GET | `/orders?patientId=&status=`, `/orders/{orderId}` | Order tracking; one order |
| 137 | POST | `/orders/{orderId}/medical-necessity-check` | ABN needed? |
| 138 | POST | `/orders/{orderId}/sign-and-send` | Send to lab |
| 139 | POST | `/orders/{orderId}/cancel` | Cancel, before specimen collection |
| 228 | POST | `/orders/{orderId}/entered-in-error` | Mark a draft order wrong; a signed order uses cancel |
| 140–141 | GET | `/orders/{orderId}/requisition`, `/orders/{orderId}/labels` | PDF download links (files) |
| 142–143 | GET | `/results?unreviewed=&patientId=`, `/results/{resultId}` | Results |
| 144 | POST | `/results/{resultId}/acknowledge` | Mark reviewed |
| 145–146 | GET, POST | `/unmatched-results`, `/unmatched-results/{unmatchedResultId}/match` | Results that couldn't be matched |
| 229 | POST | `/unmatched-results/{unmatchedResultId}/reject` | Reject with a reason; kept, never deleted |
| 147 | POST | `/encounters/{encounterId}/in-office-results` | In-clinic tests |

## Anand — data, files, admin, billing, documents

| # | Method | Path | Purpose | Storage |
|---|---|---|---|---|
| 148–149 | POST | `/files/upload-url`, `/files/{fileId}/complete` | Upload to quarantine; scan, hash, encrypt (`202`) | Files |
| 150 | GET | `/files/{fileId}/download-url` | Short-lived download link | Files |
| 151–186 | GET, POST, GET, PATCH | `/facilities`, `/locations`, `/providers`, `/appointment-types`, `/provider-schedules`, `/fee-schedules`, `/payers`, `/lab-accounts`, `/note-templates`, each also with its single item (for example `/facilities/{facilityId}`) | Practice setup | Ours (clinical: facilities, locations and providers as Organization, Location, Practitioner, PractitionerRole; admin: the rest) |
| 187 | POST | `/onboarding/import` | Bulk load for a new clinic (`202`) | Ours (admin) + files |
| 188–189 | GET, PATCH | `/encounters/{encounterId}/superbill` | Review charges | Ours (clinical) |
| 190–192 | POST, GET, GET | `/claims`, `/claims?status=`, `/claims/{claimId}` | Build a claim; claim list and history | Ours (admin) |
| 193–197 | POST | `/claims/{claimId}/scrub`, `/claims/{claimId}/submit`, `/claims/{claimId}/status-check`, `/claims/{claimId}/correct`, `/claims/{claimId}/void` | Check, send 837P, status, correct, void | Ours (admin) |
| 198–199 | POST | `/patients/{patientId}/payments`, `/payments/card-session` | Copays and card payments | Ours (admin) |
| 200–201 | GET, POST | `/remittances`, `/remittances/{remittanceId}/post` | ERA posting (P0 stretch) | Ours (admin) |
| 202–203 | GET | `/reports/ar-aging`, `/reports/charges-payments` | Billing reports | Computed |
| 204–208 | GET, GET, POST, GET, PATCH | `/documents`, `/patients/{patientId}/documents`, `/documents/{documentId}` | Document records | Ours (clinical: DocumentReference) + files |
| 209–211 | POST, GET, POST | `/faxes`, `/fax-inbox`, `/fax-inbox/{faxId}/file` | Send fax; incoming fax queue and filing | Ours (admin) + files |
| 212 | POST | `/ccda/import` | C-CDA import (`202`) | Ours (clinical: DocumentReference) + files |
| 213 | GET | `/patients/{patientId}/ccda` | C-CDA export | Files |
| 214–217 | GET, PATCH, POST, POST | `/inbox`, `/inbox/{inboxItemId}`, `/inbox/{inboxItemId}/complete`, `/messages` | Inbox and tasks | Ours (admin) |
| 218–219 | POST, GET | `/exports`, `/exports/{exportId}` | Permission-controlled exports (`202`) | Ours (admin) + files |

## Minalini — communications and dashboard (Ours (admin); the dashboard is computed)

| # | Method | Path | Purpose |
|---|---|---|---|
| 220–222 | GET, POST, PATCH | `/message-templates`, `/message-templates/{messageTemplateId}` | Reminder wording |
| 223–224 | GET, PUT | `/patients/{patientId}/communication-preferences` | SMS, email, voice; opt-outs |
| 225 | GET | `/patients/{patientId}/communications` | What was sent and delivery status |
| 226 | GET | `/dashboards/operations` | Today's counts by status (counts only, no PHI) |

## FHIR for outside systems: read-only API, owned by Anand, outside the contract

Anand's read-only FHIR API (`/fhir/...`, `backend/app/fhir/`) serves the FHIR-shaped clinical tables, behind Thulasi's machine-token check. It offers read, version read, history, search (GET and `POST _search`) and a CapabilityStatement; it returns OperationOutcome for its errors; query strings are stripped from logs (D22). It is not part of the OpenAPI contract or the first contract pass (D19): it is described by its own CapabilityStatement, not by `contracts/openapi/`. Our screens never call `/fhir`. HAPI is retired (ADR-0011).

## P1 additions (not in the first contract pass, D19)

Patient portal (`/portal/...`: appointments, intake forms, released results, messages, payments, telehealth join), referrals, immunizations, statements, waitlist, and the AI-03/AI-04 and guideline endpoints (`/ai/cds`, `/ai/coding-suggestions`, `/ai/ask`).
