# Anand — Implementation Guide (v2: single PostgreSQL, no HAPI)

**Your role:** owner of all data. You own the PostgreSQL database, which holds both the FHIR-shaped clinical tables and the normalized admin tables (adopted from Sam's schema, PR #9), the read-only FHIR API for outside systems, and the file system. You also build the practice setup, billing, documents and fax, C-CDA, inbox, export and onboarding APIs, plus the admin, billing and document screens.

**What changed from v1:** HAPI FHIR is retired (ADR-0011). Clinical data lives in our own PostgreSQL. There is no HAPI server to run, no partitions to design and no syncing between two stores. Read `docs/context/DECISIONS.md` and ADR-0011 in `docs/adr/` first.

Read `00_Team_Workflow_and_Claude_Code_Setup.md` for the repo layout, ownership and pull request rules.

## 1. What you own

| Area | Folders |
|---|---|
| Database: models, constraints, migrations, data dictionary | `backend/app/db/` |
| FHIR API for outside systems (read-only) and the FHIR serializer | `backend/app/fhir/` |
| PostgreSQL and file storage configuration | `infra/postgres/`, `infra/seaweedfs/` |
| File service | `backend/app/modules/files/` |
| Practice setup, billing, documents and fax, C-CDA, inbox, exports, onboarding | `backend/app/modules/practice_setup/`, `billing/`, `documents/`, `ccda/`, `inbox/`, `exports/`, `onboarding/` |
| Admin setup, billing and document screens | `frontend/src/features/admin-setup/`, `billing/`, `documents/` |

**Not yours:**
- Security, login, `tenant_db`, encryption keys, integration engine (Thulasi).
- API contracts (Vimal).
- Other people's modules.
- `proposals/fhir-schema/`: Sam's original. You copy from it, but never edit it.

**Rules that never bend:**
- Every clinic table has the clinic column, forced row-level security, and links that carry the clinic ID.
- Patient rows link only to the same patient.
- The application's database role never bypasses row-level security.
- Schema changes go only through Alembic migrations.

## 2. Day 1

1. Clone the repo. From this pack, copy **only** `CLAUDE.local.md` (repo root) and `.claude/settings.local.json`. Do not copy anything into `docs/context/`; the repo copies are the current ones.
2. If the ADR-0011 pull request has merged, pull `main`. If not, read this guide, `P0_SCHEMA_SCOPE.md` and PR #9 directly.
3. Start Claude Code from the repo root. Run `/memory` and `/permissions` to confirm your files are loaded and your edit limits are active.
4. Run Sam's schema locally from PR #9's branch, using a separate git worktree so you don't touch it:
   - PostgreSQL 17 with pgcrypto, pg_trgm, btree_gist and pgvector;
   - `sql/00_extensions.sql` as superuser;
   - migrations up, down and up again;
   - `alembic check`;
   - the 42 tests.

   Write down the results.
5. Run SeaweedFS (file storage) locally.
6. Send Sam your first questions on the P0 tagging (Step 1).

## 3. Build steps, in order

### Step 1 — Schema review and P0 lock (with Sam), before the 30 October lock

- Tag every one of the 218 tables P0, P0 stretch, P1 or P2 in the data dictionary, following `docs/context/P0_SCHEMA_SCOPE.md`.
- Get a yes/no and the missing columns for each of the eight "P0 items to confirm":
  - claim details for corrected claims;
  - employer of patient and subscriber;
  - MRN numbering per practice;
  - HIPAA amendment requests;
  - accounting of disclosures;
  - visit status history;
  - staff messages in the inbox;
  - occupation, industry and tribal affiliation.
- Decide how a diagnosis is "removed" before the note is signed, given that clinical tables allow no DELETE. One option: status entered-in-error with the reason "removed before signing". Agree it with Vimal, who owns the contract.
- Review the proposal's "deliberate simplifications": FHIR fields that can repeat but are stored once.
- Decide PostgreSQL 17 vs 18. On 18, UUID defaults move to `uuidv7()`.
- Write a short design note on separate `clinical` and `admin` schemas with their own database roles (pending Sena).
- Load-test the visit, results and claims write paths with synthetic data, and record the timings. The README warns that the many clinic-carrying links add insert cost.
- Lock the P0 tables. After the lock they change only through new migrations.

### Step 2 — Adopt the schema into `backend/app/db/`

- Copy the models, constraint generator, SQL and Alembic files from `proposals/fhir-schema/` into `backend/app/db/` in your own pull request. Close PR #9 afterwards, with a link to yours.
- **Remove** what the team replaced:
  - the generated admin CRUD endpoints (endpoints follow `contracts/openapi/`);
  - the proposal's own login and token-claim reading;
  - its error mapping (Thulasi's error format is used).
- **Align with Thulasi:** `tenant_db` must set exactly the database settings your row-level security policies read. The clinic comes from the server-side session, not from token claims. The database roles are a migration owner, plus an application role without RLS bypass.
- Regenerate the rules and the docs. Run migrations, `alembic check` and the tests in CI.
- Publish the data dictionary in the repo so everyone's Claude reads the same tables.

**Done when:** CI runs the full schema with every test green, and nothing from the proposal's own API or login remains.

### Step 3 — Data-access helpers for the other module owners

Vimal (patients, scheduling, encounters, history) and Thulasi (medications, orders) write their own module data-access code against your tables. Writing a FHIR-shaped record correctly is tricky: child tables, version history, provenance and entered-in-error. Give them shared helpers in `backend/app/db/`, documented in `backend/app/db/CLAUDE.md`. Examples:

```python
# examples of the interface; final names are yours
await fhir_store.create(db, Condition, data, children={...}, provenance=prov) -> Row
await fhir_store.update(db, row, changes, if_version=n, provenance=prov) -> Row   # optimistic locking
await fhir_store.entered_in_error(db, row, reason, provenance=prov) -> Row
await fhir_store.history(db, ResourceType, id) -> list[Version]
```

### Step 4 — Synthetic data and reference data

- Import Synthea's synthetic patients into the FHIR-shaped tables. This also proves the serializer round trip.
- Seed the reference data: roles, code systems, a sample fee schedule, payers.
- Code systems: ICD-10-CM, LOINC, RxNorm, CVX; SNOMED CT through the UMLS licence. CPT needs an AMA licence (still open, ADR-18), so use clearly fake codes until it's settled.

### Step 5 — FHIR API for outside systems (read-only)

- Start from the proposal's FHIR API: read, version read, history, search, CapabilityStatement.
- **Search:**
  - support both GET and POST `_search`;
  - strip query strings from every log, since patient names in a search would otherwise land in logs.
- **Errors:** use FHIR's own error format (OperationOutcome) on `/fhir` only. Our `/api/v1` uses the team's format.
- **Access:** outside systems sign in with Thulasi's machine tokens; the clinic is taken from the token through her core code. Our own screens never call `/fhir`.
- **Conformance:** run the HL7 FHIR Validator against the US Core profiles in CI. Confirm the US Core version with Vimal (9.0.0 is current).
- `/fhir` is described by its own CapabilityStatement, not in `contracts/openapi/`.

**Done when:** a test partner can read the agreed MVP resources, and every resource type passes US Core validation in CI.

### Step 6 — File system and file service

- `POST /files/upload-url` returns a short-lived link into a quarantine bucket.
- `POST /files/{id}/complete` runs a ClamAV virus scan, records the SHA-256 hash, encrypts with a data key from Thulasi's `new_data_key()`, and moves the file to the clean bucket.
- `GET /files/{id}/download-url` returns a short-lived, audited link.
- JPEG and PNG for insurance cards (M13). HEIC only if you add conversion.
- Retention rules per document type; clinical records are never deleted.

### Step 7 — Backups and restore drill

- Encrypted backups of the one database (pgBackRest, key from Thulasi) and of file storage, copied to a second U.S. region.
- Restore to a clean server, time it, and run the audit-chain check (`shri_audit_verify`) on the restored copy.

### Step 8 — Practice setup APIs and admin screens

Facilities, locations, providers, appointment types, schedules, fee schedules, payers, lab accounts, note templates. Follow Vimal's contract (the practice-setup file, which you co-own). Wire the existing screens with Minalini's design system; she reviews them.

### Step 9 — Billing, claims and payments

- The superbill is built when the visit closes. A charge can only point at a diagnosis on its own visit; the database enforces this now, because everything is in one place.
- Claims: build, scrub, submit 837P through Thulasi's integration engine, and update status from the 999, 277CA and 276/277 replies.
- Correct and void claims.
- Patient payments through the processor's hosted fields.
- Remittance (835) posting is a P0 stretch: build it last.
- Reports: accounts-receivable ageing, charges and payments.

### Step 10 — Documents, fax and C-CDA

- Document records on top of the file service.
- Fax: send through the integration engine; incoming faxes wait in `/fax-inbox` for staff to file.
- C-CDA:
  - Import: stored as a DocumentReference in our database and shown on screen. Reconciliation into the chart is P1.
  - Export: a CCD generated from our FHIR-shaped tables.

### Step 11 — Inbox, exports and onboarding import

- Inbox: built on the work queue, with staff messages if the P0 item says so.
- Exports: background jobs, permission-checked and audited.
- Onboarding import: spreadsheet templates.

**If time runs short,** these move later first, in this order:
1. Remittance posting.
2. Exports.
3. Onboarding import.
4. C-CDA export.

## 4. Handoffs

| You give | To | Needed before |
|---|---|---|
| Locked P0 schema and migrations in `backend/app/db/` | Everyone | Any API that stores data |
| RLS setting names and database roles | Thulasi | `tenant_db` |
| Data-access helpers and `backend/app/db/CLAUDE.md` | Vimal, Thulasi | Patient, encounter, history, medication and order APIs |
| Terminology and compendium tables | Vimal, Thulasi | Code search, lab ordering |
| File service | Everyone | Card images, audio, documents, PDFs |
| The answer on diagnosis removal | Vimal | Encounter contracts |

| You need | From |
|---|---|
| Encryption data keys and backup key; machine tokens for `/fhir`; `require()`, `tenant_db` | Thulasi |
| `enqueue()` for partner messages (claims, fax) | Thulasi |
| Contracts for your endpoints; you co-own the practice-setup and other module files | Vimal |
| Design review of your screens | Minalini |
| Answers on the P0 items to confirm | Sam |
| Final call on separate clinical/admin schemas | Sena |

## 5. Claude Code

Your `CLAUDE.local.md` and `.claude/settings.local.json` come in this pack. Your Claude may not edit other people's folders or Sam's `proposals/` folder. If it needs a change there, it writes a note for the owner instead.
