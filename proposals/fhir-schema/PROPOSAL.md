# Proposal: full schema with FHIR-shaped clinical tables (for review, not for merge)

Status: **PROPOSED** · 2026-10-22 · Author: Sam (drafted with Claude Code)
Requested by: Sena. **Needs decisions from:** Sena, Anand (database, HAPI, migrations), and the
other three owners (D1 is a team decision).

## What this is

A complete schema and FastAPI service, built to Sena's brief:

> Prepare the entire schema: clinical data follows the FHIR data structure, admin / non-clinical
> features are normalized, both served from FastAPI, with full integrity constraints.

* 218 tables: 28 FHIR R4 / US Core resources, 79 FHIR child tables, 111 normalized admin tables.
* 1,763 FKs, including tenant-consistent and same-patient composite FKs. 894 CHECKs, of which 405
  are FHIR invariants and datatype rules. Forced RLS on every tenant table.
* Database-maintained FHIR versioning and `_history`; triggers for signed records.
* A FHIR R4 facade and typed admin endpoints.
* Verified on PostgreSQL 17: migrations run up and down, `alembic check` reports no drift, and 42
  live-database tests pass. Every resource type validates against an independent FHIR library.

Details: [README.md](README.md), [docs/fhir_mapping.md](docs/fhir_mapping.md),
[docs/data_dictionary.md](docs/data_dictionary.md).

It sits in `proposals/` so it touches no one's folder. Nothing here is wired into `backend/`.

## It conflicts with D1. That needs a decision before anything moves.

`docs/context/DECISIONS.md` **D1**: *clinical data lives in HAPI FHIR; administrative data in our
PostgreSQL; two databases.* D1 overrides Tech Arch ADR-19. This proposal follows ADR-19 instead:
clinical data is stored in **our** PostgreSQL, *shaped* as FHIR resources, and served by a FHIR
facade. There is no HAPI.

| | D1 (current) | This proposal |
|---|---|---|
| Clinical system of record | HAPI FHIR JPA (own database) | Our PostgreSQL, FHIR-shaped tables |
| Admin data | Our PostgreSQL | Our PostgreSQL (normalized) |
| Cross-store consistency | Outbox, mirroring, pending HAPI writes (DATA_OWNERSHIP §1, §3) | One transaction, so no outbox for clinical writes |
| Integrity between clinical and admin data (charge → encounter diagnosis, order → coverage, audio → consent) | Application code across two stores | Foreign keys and CHECKs in one database |
| Signed-note immutability, final-result corrections, double-booking | Application code + HAPI versioning | Database triggers / constraints (tested) |
| Tenant isolation | HAPI partitions (open: shared resources, DEC "Still open") | Forced RLS + composite tenant FKs |
| "Clinical writes fail when HAPI is down" (DEC "Still open") | Accepted risk | Not applicable |
| FHIR conformance | HAPI validates natively | Facade output must be validated (HL7 Validator in CI; currently fhir.resources R4B in tests) |
| FHIR search breadth | Full HAPI search | Only what the facade implements |
| Effort | HAPI ops, mappings, outbox, partition design | Facade and search parameters to build |

## Decisions requested

1. **Sena, all four owners:** does D1 stand, or does Sena's brief (FHIR-*shaped* tables in our
   database) replace it? If D1 stands, see option B.
2. **Anand:** if adopted, this becomes the baseline. That settles DEC "Still open": the 83 vs
   89-table question, and "which tables move to HAPI" (none). It would be moved into
   `backend/app/db/` and split into modules by their owners.
3. **If D1 stands (option B):** keep the admin tables and the draft tables (notes, prescriptions,
   encounter diagnoses, encounter row) from this proposal as the "ours" schema. Keep the FHIR
   datatype conventions for the HAPI mappings. Drop the clinical resource tables that HAPI owns.

## Not yet aligned with repo conventions (to do if adopted)

* Module layout (`api.py → service.py → repository.py → schemas.py`), `require()` / `tenant_db`
  from `backend/app/core/`, and errors from `core/errors.py` (Problem Details, ADR-0003). The
  service here uses its own minimal auth and FHIR OperationOutcome errors.
* Contract-first: endpoints are generated from models here (`docs/openapi.json`); they would go
  through `contracts/openapi/` first (ADR-0002).
* Cursor pagination (ADR-0004), `If-Match` / ETag on writes (ADR-0008), POST search for PHI
  (D13), U.S. spelling (D18). The FHIR GET search with `family=` would conflict with D13.
* UUIDv7 (ADR-0009) once PostgreSQL 18 is in use; currently uuid4.
