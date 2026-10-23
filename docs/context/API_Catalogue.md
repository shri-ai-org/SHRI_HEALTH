# Shri Health — API Catalogue (MVP)

Every endpoint the screens and partners call, grouped by owner. Vimal turns this into `contracts/openapi/shri-health.yaml`; the contract then becomes the source of truth and this file is kept only as an overview.

**Conventions:** base path `/api/v1`. GET reads, POST creates or runs an action (`POST /x/{id}/action`), PATCH/PUT changes. No DELETE on clinical records; use entered-in-error. Every endpoint has an `x-permission`. POSTs that reach a partner take an `Idempotency-Key` header. Note and prescription updates use `ETag` / `If-Match`.

**Storage column:** everything is in our one PostgreSQL database (ADR-0011). *Ours (clinical)* = FHIR-shaped clinical tables; *Ours (admin)* = normalized admin tables; *+ files* = file storage, with only the file ID in the database. There is no HAPI.

## Thulasi — platform and security

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/login`, `/auth/callback` | Login with Keycloak (code + PKCE); session cookie holds a reference token |
| POST | `/auth/refresh`, `/auth/logout` | Refresh and revoke the session |
| GET | `/auth/session`, `/me` | Session state; current user, roles, clinic |
| GET, POST, PATCH | `/users`, `/users/{id}` | Staff accounts, synced with Keycloak |
| GET, PUT | `/roles`, `/users/{id}/roles` | Roles and role assignment |
| GET | `/events/stream` | Live updates (Server-Sent Events) |
| GET | `/audit-events`, `/reports/chart-access` | Audit search; who opened a chart |
| POST | `/patients/{id}/break-glass` | Open a restricted chart with a reason |
| POST | `/hooks/clearinghouse`, `/hooks/erx`, `/hooks/fax`, `/hooks/sms` | Partner callbacks (signature-checked) |
| GET, POST | `/admin/integration-messages`, `/admin/integration-messages/{id}/replay` | Partner message log; replay failures |
| GET | `/health`, `/ready` | Server checks |

## Vimal — front desk, encounters, history, AI

### Patients and insurance (Ours (clinical): Patient, RelatedPerson, Coverage, Consent; Ours (admin): duplicates, merges, preferred pharmacy)

| Method | Path | Purpose |
|---|---|---|
| GET | `/patients?search=` | Search by name, date of birth, phone, MRN |
| POST | `/patients` | Register |
| GET, PATCH | `/patients/{id}` | View or edit demographics |
| GET, POST | `/patients/{id}/identifiers` | MRN, licence number, other IDs |
| GET, POST, PATCH | `/patients/{id}/coverages` | Insurance, primary and secondary |
| POST | `/patients/{id}/coverages/{cid}/card-images` | Card photos (file service) |
| GET, POST | `/patients/{id}/consents` | Consents and privacy notice |
| PUT | `/patients/{id}/preferred-pharmacy` | Preferred pharmacy |
| GET | `/patients/{id}/timeline` | Longitudinal record |
| GET | `/duplicates` | Possible duplicates |
| POST | `/duplicates/{id}/merge`, `/patient-merges/{id}/undo` | Merge and undo |

### Scheduling and check-in (Ours (clinical): Appointment, Schedule, Encounter created at check-in; Ours (admin): appointment types, availability, visit flow)

| Method | Path | Purpose |
|---|---|---|
| GET | `/slots?provider=&date=` | Free times |
| POST | `/appointments` | Book, including same-day add-on |
| GET | `/appointments?date=&provider=` | Day and week views |
| PATCH | `/appointments/{id}` | Reschedule |
| POST | `/appointments/{id}/cancel` | Cancel with reason |
| POST | `/appointments/{id}/check-in` | Check in; triggers eligibility and Encounter |
| POST | `/appointments/{id}/status` | Roomed, with provider, checked out |
| GET | `/status-board` | Today's clinic flow |

### Eligibility (Ours (admin))

| Method | Path | Purpose |
|---|---|---|
| POST | `/eligibility-checks` | Run a 270/271 check through the integration engine |
| GET | `/eligibility-checks/{id}` | Result: coverage, copay, deductible |

### Encounters and notes (Ours (clinical): Encounter, vitals, diagnoses, notes from draft to signed, Provenance; Ours (admin): favorites, templates, co-sign rules)

| Method | Path | Purpose |
|---|---|---|
| POST | `/encounters` | Open a visit |
| GET, PATCH | `/encounters/{id}` | Workspace data; update |
| POST | `/encounters/{id}/vitals` | Record vitals |
| GET | `/patients/{id}/vitals` | Vitals trend |
| POST, DELETE | `/encounters/{id}/diagnoses` | Add or remove (before signing only) |
| GET | `/codes/search?system=&q=` | ICD-10, CPT, RxNorm, LOINC search |
| POST | `/encounters/{id}/notes` | Start a note from a template |
| PATCH | `/notes/{id}` | Autosave draft (If-Match) |
| POST | `/notes/{id}/sign` | Sign; locks the note |
| POST | `/notes/{id}/addenda` | Addendum to a signed note |
| POST | `/notes/{id}/cosign` | Supervising co-signature |
| GET | `/notes/{id}/versions` | History |
| GET, PUT | `/me/favourites` | Favourite templates, diagnoses, orders, phrases |
| POST | `/encounters/{id}/after-visit-summary` | Patient handout PDF |
| POST | `/encounters/{id}/close` | Close; publishes `encounter.closed` for billing |

### Patient history (Ours (clinical))

| Method | Path | Purpose |
|---|---|---|
| GET, POST, PATCH | `/patients/{id}/problems` | Problem list (Condition) |
| GET, POST, PATCH | `/patients/{id}/allergies` | AllergyIntolerance |
| GET, POST | `/patients/{id}/family-history` | FamilyMemberHistory |
| GET, POST | `/patients/{id}/social-history` | Observation, social-history category |
| GET, POST | `/patients/{id}/surgical-history` | Procedure |
| POST | `/records/{type}/{rid}/entered-in-error` | Mark wrong, never delete |

### AI (Ours (admin): requests, audio, transcripts and review logs)

| Method | Path | Purpose |
|---|---|---|
| POST | `/encounters/{id}/audio` | Upload recording (chunked, via file service) |
| POST, GET | `/ai/transcriptions`, `/ai/transcriptions/{id}` | Speech to text and status |
| POST | `/ai/note-drafts` | Transcript to draft note (AI-01) |
| POST | `/ai/chart-summaries` | Chart summary with source links (AI-02) |
| POST | `/ai/suggestions/{id}/decision` | Accept, edit or reject |
| GET, PUT | `/admin/ai-settings` | AI on/off switches |
| POST | `/ai/cds`, `/ai/coding-suggestions`, `/ai/ask` | P1: decision support, coding, cited guideline answers |

## Thulasi — clinical: medications and orders

### Medications and prescriptions (Ours (clinical): MedicationRequest from draft to signed, MedicationStatement, MedicationDispense, safety alerts; Ours (admin): pharmacy directory, e-prescribing transactions, refills)

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/patients/{id}/medications` | Medication list |
| POST | `/medications/{id}/discontinue` | Stop, with reason |
| POST | `/patients/{id}/medication-reconciliation` | Confirm list |
| POST | `/prescriptions` | Draft |
| POST | `/prescriptions/{id}/safety-check` | Allergy, interaction, duplicate, dose rules |
| POST | `/alerts/{id}/override` | Override with reason |
| POST | `/prescriptions/{id}/sign-and-send` | Sign and send to e-prescribing vendor |
| POST | `/prescriptions/{id}/cancel`, `/prescriptions/{id}/change` | Cancel or change |
| GET, POST | `/refill-requests`, `/refill-requests/{id}/respond` | Pharmacy refill requests |
| GET | `/pharmacies?search=` | Pharmacy directory |
| POST | `/patients/{id}/medication-history/fetch` | Outside prescription history |

### Orders and results (Ours (clinical): ServiceRequest, Specimen, DiagnosticReport, Observation; Ours (admin): compendium, status history, unmatched queue)

| Method | Path | Purpose |
|---|---|---|
| GET | `/lab-compendium?lab=&q=`, `/lab-compendium/{test}/questions` | Test search; ask-at-order questions |
| POST | `/orders` | Draft order |
| POST | `/orders/{id}/medical-necessity-check` | ABN needed? |
| POST | `/orders/{id}/sign-and-send` | Send to lab |
| POST | `/orders/{id}/cancel` | Cancel |
| GET | `/orders?patient=&status=` | Order tracking |
| GET | `/orders/{id}/requisition`, `/orders/{id}/labels` | PDFs |
| GET | `/results?unreviewed=true`, `/results/{id}` | Results |
| POST | `/results/{id}/acknowledge` | Mark reviewed |
| GET, POST | `/unmatched-results`, `/unmatched-results/{id}/match` | Results that couldn't be matched |
| POST | `/encounters/{id}/in-office-results` | In-clinic tests |

## Anand — data, files, admin, billing, documents

| Method | Path | Purpose | Storage |
|---|---|---|---|
| POST | `/files/upload-url`, `/files/{id}/complete` | Upload to quarantine; scan, hash, encrypt | Files |
| GET | `/files/{id}/download-url` | Short-lived download link | Files |
| GET, POST, PATCH | `/facilities`, `/locations`, `/providers`, `/appointment-types`, `/provider-schedules`, `/fee-schedules`, `/payers`, `/lab-accounts`, `/note-templates` | Practice setup | Ours (clinical: Organization, Location, Practitioner, PractitionerRole for facilities, locations and providers; admin: the rest) |
| POST | `/onboarding/import` | Bulk load for a new clinic | Ours (admin) |
| GET, PATCH | `/encounters/{id}/superbill` | Review charges | Ours (admin) |
| POST | `/claims`, `/claims/{id}/scrub`, `/claims/{id}/submit` | Build, check, send 837P | Ours (admin) |
| GET | `/claims?status=`, `/claims/{id}` | Claim list and history | Ours (admin) |
| POST | `/claims/{id}/status-check`, `/claims/{id}/correct`, `/claims/{id}/void` | Status, correct, void | Ours (admin) |
| POST | `/patients/{id}/payments`, `/payments/card-session` | Copays and card payments | Ours (admin) |
| GET, POST | `/remittances`, `/remittances/{id}/post` | ERA posting (P0 stretch) | Ours (admin) |
| GET | `/reports/ar-aging`, `/reports/charges-payments` | Billing reports | Ours (admin) |
| GET, POST, PATCH | `/documents`, `/patients/{id}/documents`, `/documents/{id}` | Document records | Ours (clinical: DocumentReference; admin: document records) + files |
| POST, GET | `/faxes`, `/fax-inbox`, `/fax-inbox/{id}/file` | Send fax; incoming fax queue and filing | Ours (admin) |
| POST, GET | `/ccda/import`, `/patients/{id}/ccda` | C-CDA import and export | Ours (clinical: DocumentReference) + files |
| GET, PATCH, POST | `/inbox`, `/inbox/{id}`, `/inbox/{id}/complete`, `/messages` | Inbox and tasks | Ours (admin) |
| POST, GET | `/exports`, `/exports/{id}` | Permission-controlled exports | Ours (admin) |

## Minalini — communications and dashboard

| Method | Path | Purpose |
|---|---|---|
| GET, POST, PATCH | `/message-templates` | Reminder wording |
| GET, PUT | `/patients/{id}/communication-preferences` | SMS, email, voice; opt-outs |
| GET | `/patients/{id}/communications` | What was sent and delivery status |
| GET | `/dashboards/operations` | Today's counts by status |

## FHIR for outside systems: read-only facade, owned by Anand

Anand's read-only FHIR API (`/fhir/...`, `backend/app/fhir/`) serves the FHIR-shaped clinical tables, behind Thulasi's machine-token check. It offers read, version read, history, search (GET and `POST _search`) and a CapabilityStatement; it returns OperationOutcome for its errors; query strings are stripped from logs (D22). It is described by its own CapabilityStatement, not by `contracts/openapi/`. Our screens never call `/fhir`. HAPI is retired (ADR-0011).

## P1 additions (not in the first contract pass)

Patient portal (`/portal/...`: appointments, intake forms, released results, messages, payments, telehealth join), referrals, immunizations, statements, waitlist, AI-03/AI-04 endpoints.
