# ADR-0011: Single PostgreSQL with FHIR-shaped clinical tables; HAPI retired

Status: **Accepted** · 2026-10-23 · Decided by the team; recorded by Vimal (drafted with Claude Code)
Supersedes: DECISIONS.md D1 (clinical data in HAPI FHIR, two databases) and the HAPI parts of D2, D7 and D8. Restores Technical Architecture v1.1 ADR-19 (application-owned PostgreSQL, no HAPI FHIR server).
Inputs: Sam's schema proposal, [PR #9](https://github.com/shri-ai-org/SHRI_HEALTH/pull/9) (branch `sam/fhir-schema-proposal`, `proposals/fhir-schema/`); [`docs/context/P0_SCHEMA_SCOPE.md`](../context/P0_SCHEMA_SCOPE.md); Anand's guide v2 ([`docs/context/03_Anand_Implementation_Guide.md`](../context/03_Anand_Implementation_Guide.md)).

## Context

D1 put clinical data in a HAPI FHIR JPA server with its own PostgreSQL, and administrative data in ours: two databases. That design needed:

- an outbox and mirroring to keep the two stores in step (Patient, Practitioner, Organization, Location, Coverage, Encounter), with nightly reconciliation;
- client-assigned IDs and ETag translation between the stores (ADR-0008, ADR-0009);
- HAPI partitions per clinic, with an open question on where shared resources live (Thulasi T30, Anand A33);
- an accepted risk that clinical writes fail while HAPI is down (rooming stops);
- a content-hash check between the signed note in ours and its copy in HAPI.

Sam's proposal (PR #9), built to Sena's brief, follows Tech Arch ADR-19 instead. It has 218 tables: 28 FHIR R4 / US Core resources, 79 FHIR child tables and 111 normalized admin tables. It also has 1,763 foreign keys (715 composite clinic-carrying, 77 same-patient), 894 CHECK constraints, forced row-level security on every clinic table, and database-maintained FHIR versioning and `_history`. Migrations up and down, `alembic check` and 42 live-database tests pass on PostgreSQL 17.7.

## Decision

**Option A.**

- **One database.** All data is in our own PostgreSQL 18:
  - clinical data in FHIR-shaped tables (Sam's schema, PR #9);
  - administrative data normalized in the same database.
- **One transaction.** Writes that belong together commit together.
- **Read-only `/fhir` for outside systems.** It serves the FHIR-shaped tables; our screens use `/api/v1` only.
- **No HAPI.** There is no HAPI server; `infra/hapi/` is retired.

### Conditions (recorded exactly)

1. **Contract-first stays (ADR-0002).** Sam's generated admin endpoints are dropped; DB names map to contract camelCase in each module's repository. **Accepted.**
2. **Thulasi's core is used:** `require()`, `tenant_db`, Problem Details, the session cookie. **Accepted.**
   - `tenant_db` sets the database settings the schema's RLS policies read: `app.current_tenant_id`, `app.current_user_id`, `app.correlation_id` (Sam's `shri/db/session.py`).
   - The clinic comes from the server-side session, not token claims.
3. **The external `/fhir` API is read-only.** **Accepted.**
   - It keeps OperationOutcome for its errors.
   - It offers `POST _search`.
   - Query strings are stripped from logs (D13).
   - Our screens never call `/fhir`.
4. **Separate schemas and roles in one database.** **Accepted (decided 2026-10-23):** three schemas, `clinical` (FHIR-shaped), `admin` (normalized) and `audit` (append-only audit chain), and one database role per service, each with the minimum grants:
   - `shri_app` for the API: clinical and admin read/write, audit insert only;
     *Partly superseded by D23 (amended): shri_app reads and inserts audit_event.*
   - `shri_fhir_reader` for `/fhir`: clinical read only;
   - `shri_integration` for the partner worker: integration tables plus result filing;
   - `shri_reporting`: read-only, approved views only;
   - `shri_migrator`: owns everything; used only for migrations.

   RLS stays forced on every clinic table. Anand implements this during schema adoption.
5. **Before the 30 October lock, only P0 tables are locked** (`P0_SCHEMA_SCOPE.md`). Also before the lock, owners Anand and Sam:
   - **0..1 simplifications:** the deliberate simplifications in Sam's README are **approved as listed**.
   - **Diagnosis removal without DELETE:** **decided.** Removing a diagnosis before the note is signed sets the Condition's verification status to `entered-in-error` with a reason, and a `Provenance` record of who removed it and why. An entered-in-error diagnosis is excluded from the chart, the problem list, decision support, AI summaries, claims and patient-facing views; it is kept only for audit. The database refuses a charge or claim line that points at an entered-in-error diagnosis. There is no DELETE anywhere.
   - **A load test:** Anand, with Sam, on the visit, results and claims write paths.
   - **PostgreSQL 17 vs 18:** **decided: PostgreSQL 18, on the latest 18.x minor release. Move to PostgreSQL 19 only after it has had a couple of minor releases.** 18 stays because it is the latest stable release, has data checksums on, and passed Anand's verification (migrations, `alembic check` and 42/42 tests identical to 17; D28). IDs stay UUIDv4 (D29, ADR-0009). ~~UUID defaults move to `uuidv7()`.~~
   - **The eight "P0 items to confirm"** in `P0_SCHEMA_SCOPE.md` are **approved as P0**. Sam and Anand add whatever is missing before the lock.
6. **The outbox is for external partners only** (labs, e-prescribing, clearinghouse, fax, SMS). Never for our own database. **Accepted.**
7. **Before India:** designs for market code systems and DPDP erasure. **Accepted**; owner Anand.

Also decided on 2026-10-23, alongside this ADR:

- **Full SSN is never stored.** Only a hash and the masked last four, as the schema already enforces (HIPAA minimum necessary).
- **The legal record of a signed note** is the signed note row in our database (Composition, immutable after signing, every version in `_history`). The question of a content hash between two stores is gone.

## Options considered

| Option | Summary | Outcome |
|---|---|---|
| **A** | One PostgreSQL; clinical tables FHIR-shaped (Sam's schema), admin normalized; read-only `/fhir` facade | **Chosen** |
| B (Sam's fallback) | Keep D1 (HAPI for clinical data); take only the admin and draft tables from Sam's proposal | Rejected: keeps two stores and all the consistency, partition and outage work listed under Context |
| Keep D1 unchanged | HAPI for clinical data with the earlier 89-table admin schema | Rejected: the same costs as B, and the admin schema is less complete than Sam's |

## Consequences

**Better:**

- **Integrity:** one transaction, foreign keys and CHECKs span clinical and admin data, e.g. a charge can only point at a diagnosis on its own visit.
- **Removed work:** no mirroring, no HAPI reconciliation, no HAPI-down failure mode, no partitions.
- **Clinic isolation** is forced RLS, links that carry the clinic ID, and same-patient links.

**Costs:**

- **The `/fhir` facade** and its search parameters are ours to build and test. The HL7 FHIR Validator with US Core runs in CI against `/fhir`.
- **FHIR search breadth** is only what we implement.
- **Insert cost:** the many composite foreign keys add it; the load test (condition 5) measures it before the lock.

**Superseded:**

- The HAPI parts of D1, D2, D7 and D8.
- Open items T30 and A33 (HAPI partitions and shared resources).
- The HAPI-down accepted risk and the `clinical-store-unavailable` error.
- Patient, Practitioner, Organization, Location and Coverage mirroring.
- Client-assigned HAPI IDs and ETag translation (ADR-0008, ADR-0009).
- HAPI paging inside cursors (ADR-0004).
- The legal-record hash question.

**Follow-ups:**

- **Thulasi:** remove `/infra/hapi/` from CODEOWNERS and the folder; align `tenant_db` setting names; clinic from the server-side session; outbox for partners only; machine tokens for `/fhir`.
- **Anand:** adopt the schema baseline (guide v2, Steps 1–2).

**Still open (not decided here):** the US Core version (Open Decisions Q6, needed before the schema lock; tied to ONC certification, Q5) and the CPT license (Q7, needed before the pilot; the code-table design is part of the schema lock regardless). Both are in DECISIONS.md "Still open".

## References

DECISIONS.md D1 (rewritten), D2, D7, D8; Technical Architecture v1.1 ADR-19 and ADR-03; PR #9; P0_SCHEMA_SCOPE.md; ADR-0002, ADR-0003, ADR-0004, ADR-0006, ADR-0008, ADR-0009.
