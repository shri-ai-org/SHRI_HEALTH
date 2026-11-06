# Shri Health API: FHIR-shaped clinical schema and normalized admin schema (FastAPI)

The complete database schema and FastAPI service for Shri Health OpenEMR Edition, built against
MVP FRS v1.2, Technical Architecture v1.1 and Implementation Plan v1.1 (21 October 2026).

* **Clinical data follows the FHIR R4 / US Core structure.** One table per FHIR resource, columns
  named after FHIR elements, repeating elements in child tables, FHIR invariants as CHECK
  constraints, and FHIR versioning (`meta.versionId`, `_history`) maintained by the database.
* **Admin and non-clinical data is normalized** (3NF): tenancy, users and roles, scheduling
  setup, templates and favourites, compendium, revenue cycle, integration, AI governance, audit.
* **Both are served by one FastAPI app**: a FHIR R4 facade over the clinical tables (ADR-19,
  no separate FHIR server) and typed CRUD endpoints for the admin tables.
* **Integrity is enforced in PostgreSQL**, not only in the API (see [Integrity rules](#integrity-rules)).

`shri_health_db` (89 tables) remains the reference for the earlier design; this project replaces
it. Everything below was verified on PostgreSQL 17.7: migrations up and down, `alembic check` with
no drift, and 42 live-database tests.

## At a glance

| | |
|---|---|
| Tables | 218: 28 FHIR resources, 79 FHIR child / datatype tables, 111 admin tables |
| Foreign keys | 1,763, of which 715 composite tenant FKs and 77 same-patient FKs |
| CHECK constraints | 894, of which 405 FHIR datatype / invariant rules |
| Unique / exclusion | 227 unique, 1 exclusion (no double booking) |
| Indexes | 887 |
| Triggers / functions | 214 triggers, 56 `shri_*` functions |
| Row-level security | 216 policies; forced on all 208 tenant tables |
| API | 212 OpenAPI paths, 285 generated schemas (`docs/openapi.json`) |

FHIR resources: AllergyIntolerance, Appointment, Composition, Condition, Consent, Coverage,
DetectedIssue, DiagnosticReport, DocumentReference, Encounter, FamilyMemberHistory, Immunization,
Location, Medication, MedicationDispense, MedicationRequest, MedicationStatement, Observation,
Organization, Patient, Practitioner, PractitionerRole, Procedure, Provenance, RelatedPerson,
Schedule, ServiceRequest, Specimen. This covers FRS §4 (incl. FamilyMemberHistory and C-CDA via
DocumentReference) plus the Tech Arch §6.2 gaps. Slot is computed, not stored; AuditEvent is
served from the admin `audit_event` table.

## Layout

```
shri/
  db/base.py            Base, mixins (tenant, provenance, FHIR resource / child)
  db/fhir_types.py      FHIR datatype column factories: cc(), quantity(), period(), ref() ...
  db/session.py         tenant-scoped async sessions (SET LOCAL tenant + user)
  models/fhir/          clinical tables (FHIR-shaped)
    datatypes.py          shared Identifier / HumanName / ContactPoint / Address / Annotation / Dosage
    directory.py          Patient, RelatedPerson, Practitioner, PractitionerRole, Organization, Location
    workflow.py           Schedule, Appointment, Encounter
    clinical.py           Condition, AllergyIntolerance, Observation, Procedure, FamilyMemberHistory, Immunization
    medication.py         Medication, MedicationRequest, MedicationStatement, MedicationDispense, DetectedIssue
    orders.py             ServiceRequest, Specimen, DiagnosticReport
    documents.py          DocumentReference, Composition (clinical notes)
    records.py            Consent, Coverage, Provenance, fhir_resource_history
  models/admin/         normalized tables
    core.py               tenant, settings, facility, users, RBAC, care team, co-sign rules, terminology, picklists
    practice.py           appointment types, availability, visit flow, templates, favourites, CDS rules, inbox
    orders.py             labs, compendium, AOE, requisitions, ABN, medical necessity, status history, unmatched results
    medication.py         pharmacy directory, preferred pharmacy, eRx transactions
    rcm.py                payers, enrollment, eligibility, fee schedules, superbill, charges, claims, ERA, payments
    comms.py              object storage, communication preferences, templates, outbound messages, eFax
    ai.py                 AI settings, prompts, requests, suggestions + evidence, audio, transcripts, RAG
    platform.py           audit chain, break-the-glass, duplicates / merge, integration messages, migration
  models/constraints.py generated constraints (FHIR rules, arcs, tenant FKs, same-patient FKs)
  fhir/serializer.py    rows / history snapshots -> FHIR JSON, driven by column metadata
  api/fhir.py           FHIR facade: read, vread, history, search, CapabilityStatement
  api/admin.py          typed admin CRUD generated from the models
  main.py               FastAPI app + database-error mapping
sql/                    00_extensions (run by a superuser) + generated / hand-written SQL
alembic/versions/       0001 baseline, 0002 rules + RLS; frozen SQL in sql_0001/, sql_0002/
tools/gen_db_rules.py   regenerates sql/*.sql from the models
tools/gen_docs.py       regenerates docs/
docs/                   data_dictionary.md, fhir_mapping.md, openapi.json
tests/                  test_db_rules.py (34), test_fhir_facade.py (8)
```

## Run it

```bash
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt

# once per database, as a superuser
psql -d shri_health -f sql/00_extensions.sql          # pgcrypto, pg_trgm, btree_gist, vector, roles

# migrations run as shri_migrator (table owner)
export SHRI_MIGRATION_DATABASE_URL=postgresql+psycopg://shri_migrator:***@host/shri_health
alembic upgrade head
alembic check                                         # must report no drift

# API runs as shri_app (NOBYPASSRLS)
export SHRI_DATABASE_URL=postgresql+psycopg://shri_app:***@host/shri_health
export SHRI_OIDC_ISSUER=... SHRI_OIDC_AUDIENCE=... SHRI_OIDC_JWKS_URL=...
uvicorn shri.main:app

# tests (live database at head)
export SHRI_TEST_ADMIN_URL=postgresql+psycopg://postgres@host/shri_health
pytest -q
```

Keycloak tokens must carry `shri_tenant_id` and `shri_user_id` claims (names configurable).

## Clinical tables: how FHIR maps to columns

| FHIR | Stored as | Example |
|---|---|---|
| Resource | table, PK = logical id | `observation.id` |
| `meta.versionId` / `lastUpdated` | `meta_version_id`, `meta_last_updated` (trigger) | |
| `meta.security` | `meta_security varchar[]`, CHECK on v3 codes | `{R}` = restricted chart |
| primitive | column named after the element (snake_case) | `effective_date_time` |
| required-binding code | VARCHAR + CHECK on the FHIR value set | `status` |
| CodeableConcept | `<el>_system` (FK → `code_system.uri`), `_code`, `_display`, `_text` | `code_system`, `code_code` |
| extra codings | `<resource>_coding` child table | ICD-10-CM + SNOMED on one Condition |
| Quantity / Age / Duration | `<el>_value`, `_comparator`, `_unit`, `_system`, `_code` | `value_quantity_value` |
| Period, Range | `<el>_start/_end`, `<el>_low_*/_high_*` | `effective_period_start` |
| Reference(X) | FK column `<el>_<x>_id` | `subject_patient_id` |
| Reference(A\|B\|C) | one FK per type + generated "exactly / at most one" CHECK | `performer` arcs |
| choice `[x]` | one column group per type + generated exclusivity CHECK | `value_quantity_*` vs `value_string` |
| 0..* element | child table `<resource>_<element>` | `observation_component` |
| Identifier, HumanName, ContactPoint, Address, Annotation, Dosage | shared datatype tables, exactly one owner FK | `human_name.patient_id` |
| Shri extensions | `ext_*` columns | `ext_fulfillment_status` |

Every FHIR column carries `info` metadata. One source drives three things: the generated
constraints, the FHIR JSON serializer and the data dictionary, so they cannot drift apart.
The test suite serializes every resource type and parses it with an independent FHIR library
(`fhir.resources`, R4B).

## Integrity rules

All of these are enforced by PostgreSQL. Each has a test in `tests/test_db_rules.py`.

**Tenancy and patients**
* Forced RLS on every tenant table. The API role cannot bypass it, and a connection with no
  tenant set sees zero rows.
* Composite `(tenant_id, x_id)` FKs on every FK between tenant tables. FK checks bypass RLS,
  so without these one tenant could reference another tenant's rows.
* Same-patient FKs. A row that belongs to a patient can only reference rows of that same patient
  (encounter, condition, coverage, related person, prior prescription ...). They are deferrable,
  so a merge can move a whole chart in one transaction.
* Uniqueness that could reveal another tenant's data is always scoped per tenant
  (identifiers, storage keys, idempotency keys).

**FHIR structure**
* Coding pairs (system ⇔ code), display needs a code, `qty-3`, `per-1`, `rng-2`.
* Required elements, reference arcs, and choice-type exclusivity.
* Invariants: `con-4`, `con-5`, `ait-1`, `ait-2`, `obs-3`, `obs-6`, `app-2`, `app-3`, `app-4`,
  `fhs-1`, `fhs-2`, `tim-1`, `mdd-1`.
* Value-set bindings for key codes: Condition.code is ICD-10-CM / SNOMED, medications are
  RxNorm / NDC, vaccines are CVX, procedures and charges are CPT / HCPCS.
* Every CodeableConcept system must be a registered `code_system`.

**Clinical safety**
* **Notes (Composition).**
  * A final note needs a legal attester whose user is linked to that practitioner.
  * Signed content is frozen; corrections are addenda (`relatesTo appends/replaces`).
  * A co-signature can be added after signing. Attestations are insert-only.
  * An AI-drafted section must be accepted or edited before the note can be signed.
* **Prescriptions.**
  * Beyond draft, a signing practitioner is required, and signed content is frozen.
  * Schedule II prescriptions allow no refills; Schedules III–V allow at most 5.
  * A high-severity CDS alert must have an override reason before the prescription can become
    active, and high-severity rules cannot be suppressed per user.
* **Orders.**
  * Beyond draft, a signature is required and signed content is frozen.
  * AOE answers must match the question's answer type and options.
* **Results.** A final Observation or DiagnosticReport can only change with status
  `corrected` / `amended`, and status never goes backwards. Every version is kept.
  Release to the patient needs a named human.
* **Scheduling.** A practitioner cannot be double-booked (exclusion constraint), except overbooks,
  appointment types that allow overlap, and cancelled appointments.
* **AI.** Suggestion output is immutable and the decision is recorded once. Rows marked
  `ai-generated` need an accepted suggestion and a verifier. Audio needs an *active*
  ambient-recording consent of the same patient; the kind of consent is pinned by a composite FK.
* **Billing.**
  * Diagnosis pointers are rows with composite FKs, so a charge can only point at a diagnosis
    on its own encounter and a claim line only at one on its own claim.
  * `total = units × price`.
  * Card numbers are rejected in payment references.
* **PHI.**
  * SSNs only as a hash or masked last four digits.
  * NPIs check-digit validated.
  * DEA numbers, TINs and credentials stored only as OpenBao references.
  * Integration settings cannot hold secrets.

**Records and audit**
* DELETE is not granted on resource tables (corrections use status `entered-in-error`). It is
  granted only on child rows (guarded by the parent's state) and on configuration tables.
* `fhir_resource_history` stores every committed version with its child rows. It is written only
  by a SECURITY DEFINER trigger at commit and is read-only for the API.
* `audit_event` is append-only with a per-tenant SHA-256 hash chain; `shri_audit_verify(tenant)`
  detects tampering even by a superuser. Reads, searches, denials (in their own transaction) and
  break-the-glass are audited.

## Adding or changing a table

1. Change the models. Use the `fhir_types` helpers for FHIR tables.
2. `python -m tools.gen_db_rules`, then write a **new** Alembic revision containing only the new
   or changed DDL, triggers (version / history / touch for FHIR tables) and RLS for the new tables.
   Never edit `sql_0001/` or `sql_0002/`.
3. `alembic upgrade head && alembic check && pytest -q && python -m tools.gen_docs`.

Until the first deployment, the baseline can still be regenerated wholesale. After go-live,
migrations are append-only.

## Deliberate simplifications (review before the 30 October schema lock)

* A few FHIR 0..* elements are stored as 0..1:
  * reasonReference-only links on Observation, Procedure and MedicationStatement `basedOn` (one
    request);
  * DocumentReference `context.encounter`;
  * one `doseAndRate` per dosage;
  * one reference range and one interpretation per Observation component;
  * single-coding `type` on Organization, Location and PractitionerRole.

  Each is a one-table change if a partner needs more.
* Nested Composition sections are stored (`parent_section_id`) but serialized flat.
* `Patient.contact` invariant pat-1 is checked in the API, because it spans child tables.
* `ai_suggestion.content` / `edited_content` and `prompt_template.output_schema` stay JSONB: they
  are model output documents validated against the prompt's JSON Schema, not relational data.
* The FHIR facade is read-only. Clinical writes go through domain endpoints (sign note, place
  order, prescribe, file result), so the safety workflow stays in one place. Those endpoints are
  the next build step; the admin CRUD endpoints are complete.

## Open items

* **US Core conformance.** The tests check FHIR R4B structure with `fhir.resources`. US Core
  profile validation needs the HL7 FHIR Validator in CI (Tech Arch Appendix A).
* **Performance.** 715 composite tenant FKs and 77 same-patient FKs add insert cost. Load-test the
  encounter, results and claims paths before the pilot. Add indexes on hot referencing columns
  as measured.
* **PostgreSQL 18.** Switch UUID defaults to `uuidv7()`. Verified on 17; nothing newer than 15 is
  used (`NULLS NOT DISTINCT`).
* **P1 / P2 tables not yet modelled** (Tech Arch §6.2):
  * portal accounts, telehealth sessions;
  * patient ledger and statements;
  * QuestionnaireResponse for intake;
  * prior authorisation (P2);
  * EPCS two-factor evidence beyond `provenance_signature`;
  * 42 CFR Part 2 record-level labels — these will use `meta_security` on each resource.
* **Licence.** The old README said AGPL. Confirm with counsel (Tech Arch §9) before publishing
  this code.
