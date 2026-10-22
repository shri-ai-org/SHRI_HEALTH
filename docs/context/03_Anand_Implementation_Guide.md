# Anand — Implementation Guide

**Your role:** owner of all data: our PostgreSQL database, the HAPI FHIR server holding clinical data, and the file system. You also build the practice setup, billing, document, fax, C-CDA, inbox, export and onboarding APIs, plus the admin, billing and document screens.
Read `00_Team_Workflow_and_Claude_Code_Setup.md` first.

## 1. What you own

| Area | Folders |
|---|---|
| Database models and migrations | `backend/app/db/` |
| HAPI FHIR client and mappings | `backend/app/fhir/` |
| HAPI, PostgreSQL and file storage configuration | `infra/hapi/`, `infra/postgres/`, `infra/seaweedfs/` |
| File service | `backend/app/modules/files/` |
| Practice setup, billing, documents and fax, C-CDA, inbox, exports, onboarding | `backend/app/modules/practice_setup/`, `billing/`, `documents/`, `ccda/`, `inbox/`, `exports/`, `onboarding/` |
| Admin setup, billing and document screens | `frontend/src/features/admin-setup/`, `billing/`, `documents/` |

**Rule that never bends:** application code reaches HAPI only through its FHIR API (`backend/app/fhir/`). Nobody, including you, reads or writes HAPI's internal tables from the application.

## 2. Day 1

1. Compare the 83-table baseline with the 89-table `shri_health_db` and agree one baseline. Then sort every table into one of three groups:

   | Group | Examples |
   |---|---|
   | Stays in our database | Users, roles, facilities, providers, schedules, appointments, patient registration and insurance, eligibility, fee schedules, claims, payments, documents metadata, communications, work queue, AI requests, audit, integration messages, favourites, note and prescription drafts |
   | Moves to HAPI as FHIR resources | Encounter, Condition, Observation, AllergyIntolerance, Procedure, FamilyMemberHistory, MedicationRequest, MedicationStatement, ServiceRequest, DiagnosticReport, signed notes (DocumentReference), Provenance |
   | Our table keeps a pointer to HAPI | Any of our rows linked to a clinical record stores the HAPI resource ID and version |

2. Run `shri_health_db` locally: PostgreSQL 16 with pgvector, `alembic upgrade head`, `alembic check`, then the tests.
3. Run HAPI FHIR locally with its own PostgreSQL (the `hapiproject/hapi` Docker image), load the US Core package, and confirm `/fhir/metadata` responds.
4. Run SeaweedFS locally and create test buckets.

## 3. Build steps, in order

### Step 1 — Our database (admin data)

- Turn the agreed baseline into Alembic migrations. Clinical tables that moved to HAPI are removed, or kept only as draft/workflow tables.
- Add the P0 gap tables:
  - `user_clinical_preference` (favourites and suppressed alerts);
  - `service_request_status_event` (order status history);
  - `fax` in the integration and communication channel lists.
- Regenerate the row-level security policies; tell Thulasi the setting name they read so `tenant_db` matches.
- Seed reference data:
  - roles;
  - code systems;
  - sample fee schedule;
  - payers.

**Done when:** `alembic check` reports no drift and the RLS tests pass.

### Step 2 — HAPI FHIR server

- **Configuration in `infra/hapi/`:**
  - FHIR R4 on its own PostgreSQL;
  - US Core installed;
  - validation on write for profiled resources;
  - the search parameters the screens need.
- **Clinic isolation:** turn on HAPI partitioning (multitenancy) so one clinic can never read another's FHIR data. Row-level security in our database does not apply inside HAPI, so this is the protection there.
- **Access:** only from the API and integration service network, with Thulasi's machine-token check.
- **Backups:** encrypted backups of HAPI's database (same method as ours).
- **Test data:** load Synthea synthetic patients. Synthea produces FHIR bundles you can post straight to HAPI; seed matching registration rows in our database.

**Done when:** a synthetic patient's full record can be read through HAPI by the API with a machine token, and a request without a token is refused.

### Step 3 — FHIR client and mappings (`backend/app/fhir/`)

Vimal and Thulasi call this package instead of talking to HAPI themselves. Give them simple functions:

```python
# examples of the interface — one module per resource type
await fhir.patients.upsert(patient_row) -> FhirRef
await fhir.encounters.create(encounter_input) -> FhirRef
await fhir.observations.create_vitals(encounter_ref, vitals) -> list[FhirRef]
await fhir.conditions.add(patient_ref, condition_input) -> FhirRef
await fhir.documents.store_signed_note(note_version, author) -> FhirRef   # also writes Provenance
await fhir.medication_requests.create(prescription_version) -> FhirRef
await fhir.service_requests.create(order) -> FhirRef
await fhir.diagnostic_reports.create_from_result(result) -> FhirRef
await fhir.search(resource_type, params) -> Bundle
```

- Async HTTP client with the machine token, timeouts and retries.
- Never blindly retry a create. Use conditional create (match on our own ID stored as an identifier), so a retry can't make a duplicate.
- Version-aware updates (`If-Match`), so two writers can't overwrite each other.
- Add a `Provenance` on every write, recording who or what (including AI) produced it.
- Map to US Core profiles with the `fhir.resources` library; add FHIR Validator checks to CI.
- Also build the OpenEMR 8.x column mapping (OpenEMR column → our table or FHIR element) for later migration.

### Step 4 — File system and file service

- `POST /files/upload-url` returns a short-lived upload link into a quarantine bucket.
- `POST /files/{id}/complete` runs a ClamAV virus scan and records the SHA-256 hash. It then encrypts the file with a data key from Thulasi's `new_data_key()` and moves it to the clean bucket.
- `GET /files/{id}/download-url` returns a short-lived, audited link.
- Retention rules per document type; nothing is ever deleted from clinical records.

**Done when:** an uploaded file is scanned, stored encrypted, and downloadable only with a fresh link.

### Step 5 — Backups and restore drill

Encrypted backups of both databases (pgBackRest, key from Thulasi) and file storage, copied to a second U.S. region. Restore once to a clean server and time it.

### Step 6 — Practice setup APIs and admin screens

Facilities, locations, providers (NPI, DEA, licence), appointment types, provider schedules, fee schedules, payers, lab accounts, note templates. Plain create/read/update APIs over your own tables. Connect the existing admin screens to them, or build the missing ones, using Minalini's design system; she reviews them.

### Step 7 — Billing, claims and payments

Superbill:
- Built when Vimal's `encounter.closed` event fires.
- Contents:
  - charges with CPT/HCPCS codes and modifiers;
  - units;
  - place of service;
  - diagnosis pointers;
  - prices from the fee schedule.

Claims:
- Build and scrub for basic errors.
- Submit as 837P through `integration.enqueue("clearinghouse", "837P", ...)`.
- Update status from the 999, 277CA and 276/277 replies through webhook handlers.
- Correct and void.

Payments and reports:
- Patient payments: card payments use the processor's hosted fields (`/payments/card-session`), so card numbers never reach us.
- Remittance (835) posting: build last; first to move later if time runs short.
- Reports: accounts-receivable ageing, charges and payments.
- Connect or build the billing screens.

### Step 8 — Documents, fax and C-CDA

- Document records on top of the file service: category, link to patient and visit.
- Fax:
  - send through the integration engine;
  - incoming faxes land in `/fax-inbox` for staff to match to a patient and file.
- C-CDA:
  - Import: parse the CCD, store it as a document and a `DocumentReference` in HAPI, show it on screen. Evaluate the open-source Microsoft FHIR-Converter for the parsing.
  - Export: generate a CCD from the patient's HAPI data.
- Connect or build the document screens.

### Step 9 — Inbox, exports and onboarding import

- **Inbox:** on `work_queue_item`, with assign, priority, due date and complete; new items publish a live update.
- **Exports:** run as background jobs, permission-checked and audited.
- **Onboarding import:** spreadsheet templates that bulk-load providers, fee schedules and payers for a new clinic.

**If time runs short,** these move later first, in this order:
1. Remittance posting.
2. Exports.
3. Onboarding import.
4. C-CDA export.

## 4. Handoffs

| You give | To | Needed before |
|---|---|---|
| Agreed schema and admin migrations | Everyone | Any API that stores data |
| RLS setting name, audit hash-chain function | Thulasi | `tenant_db`, audit |
| HAPI running and the FHIR client functions | Vimal, Thulasi | Encounter, history, medication and order APIs |
| Terminology tables (codes), compendium tables | Vimal, Thulasi | Code search, lab ordering |
| File service | Everyone | Card images, audio, documents, PDFs |

| You need | From |
|---|---|
| Encryption data keys and backup key; machine tokens; HAPI protection | Thulasi |
| `enqueue()` and webhook hand-off | Thulasi |
| `encounter.closed` event | Vimal |
| Contracts for your endpoints | Vimal (you propose changes by pull request) |
| Design review of your screens | Minalini |

## 5. Your Claude Code settings

Save as `.claude/settings.local.json`, start `claude` from the repo root, run `/permissions` to check:

```json
{
  "permissions": {
    "deny": [
      "Edit(contracts/**)",
      "Edit(backend/app/core/**)", "Edit(backend/app/integration/**)",
      "Edit(backend/app/modules/patients/**)", "Edit(backend/app/modules/scheduling/**)",
      "Edit(backend/app/modules/eligibility/**)", "Edit(backend/app/modules/encounters/**)",
      "Edit(backend/app/modules/history/**)", "Edit(backend/app/modules/ai/**)",
      "Edit(backend/app/modules/medications/**)", "Edit(backend/app/modules/orders/**)",
      "Edit(backend/app/modules/communications/**)", "Edit(backend/app/modules/dashboards/**)",
      "Edit(ai/**)",
      "Edit(frontend/src/design-system/**)", "Edit(frontend/src/app/**)",
      "Edit(frontend/src/features/patients/**)", "Edit(frontend/src/features/scheduling/**)",
      "Edit(frontend/src/features/clinical/**)", "Edit(frontend/src/features/medications/**)",
      "Edit(frontend/src/features/orders/**)", "Edit(frontend/src/features/inbox/**)",
      "Edit(frontend/src/features/portal/**)", "Edit(frontend/src/features/ai/**)",
      "Edit(infra/compose/**)", "Edit(infra/nginx/**)", "Edit(infra/keycloak/**)", "Edit(infra/terraform/**)",
      "Edit(.github/**)"
    ]
  }
}
```

Your list is the longest of the four. Use git worktrees to keep HAPI work and API work on separate branches with separate Claude sessions.
