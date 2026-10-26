# backend/app/db/ — database layer (Anand)

Adopted from Sam's proposal (PR #9) per ADR-0011/D23, split into three PostgreSQL schemas in
one database: `clinical` (FHIR-shaped resources + `fhir_resource_history`), `admin` (normalized,
non-clinical tables), `audit` (`audit_event`, `break_glass_access` only).

## The `tenant_db` contract

Every endpoint uses `Depends(require("<permission>"))` and `Depends(tenant_db)` (Thulasi's
`backend/app/core/`). For the row-level security policies and triggers in this package to see
the right tenant, `tenant_db` must set exactly these three settings, transaction-local
(`set_config(name, value, true)`, not session-local — a pooled connection must never leak one
request's tenant into the next):

| Setting | Holds |
|---|---|
| `app.current_tenant_id` | the clinic, from the server-side session — **never** from a token claim or other client input |
| `app.current_user_id` | the signed-in user, for provenance and the audit chain |
| `app.correlation_id` | the request ID, carried into `audit_event.correlation_id` |

The implementation is the core's: `Database.tenant_session` in `backend/app/core/db.py` and
`tenant_db` in `backend/app/core/deps.py`. This package owns no engine and no session.
`app/db/session.py` only holds the hook that fills `tenant_id` on new rows from
`session.info["tenant_id"]`, which the core's `tenant_session()` sets to the clinic UUID (PR #28,
`app.core.db.TENANT_ID_INFO_KEY`). It fills only an empty `tenant_id` and never overwrites one.

## The /fhir session

`/fhir` does not use `tenant_db`. It runs as `shri_fhir_reader` (`FHIR_DATABASE_URL`, read-only,
D22/D23) with the clinic taken from the machine token. `backend/app/fhir/api.py` gets its
session from one dependency, `fhir_db`, a seam (like `machine_token_auth`) until Thulasi's core
provides it. The facade commits its own audit rows (`audit()`), including before a 403, so the
real `fhir_db` must set the three settings again on every new transaction, as `tenant_db` does.

`shri_fhir_reader` may also insert into `audit.audit_event` and nothing else on `audit` (no
SELECT, so the facade's audit insert never uses RETURNING; no access to `break_glass_access`).
Restricted charts are not served on `/fhir`; that part of the facade is still being designed.

A role never bypasses RLS: `shri_app`, `shri_fhir_reader`, `shri_integration` and
`shri_reporting` are all `NOBYPASSRLS`. Only `shri_migrator` has elevated rights, and only for
schema changes, never for serving a request.

## The five database roles (D23)

| Role | Use | Access |
|---|---|---|
| `shri_app` | the API | `clinical` + `admin` read/write per table (see `tools/gen_db_rules.py`'s classification); `audit.audit_event` select+insert, never update or delete (0004), `audit.break_glass_access` select+insert |
| `shri_fhir_reader` | `/fhir` (read-only, machine-token access) | `clinical` schema, `SELECT` only; `audit.audit_event` `INSERT` only (migration 0003) |
| `shri_integration` | the partner worker | narrow: order tables it reads to match a result, result tables it files into (select, insert, update; never delete; 0004), the three `integration_*` admin tables, and `audit.audit_event` `INSERT` only (0004) |
| `shri_reporting` | approved reports | nothing yet — no reporting views exist; grants come when they do |
| `shri_migrator` | migrations only | owns all three schemas |

`shri_app`, `shri_integration` and `shri_fhir_reader` also have `USAGE` (never `CREATE`) on
schema `public`, where the rule functions that every trigger calls live (migration 0003). The
database image revokes all access to `public` from PUBLIC, so without it no write could fire
its triggers.

Role **creation** happens outside this package: locally/CI via
`infra/compose/postgres/initdb/10-service-roles.sh` (Thulasi); on RDS, by the master role plus
`shri_migrator` (ADR-0012). `sql/00_extensions.sql` here only creates the three schemas and
installs extensions, and grants to roles it assumes already exist — never create or `GRANT ...
TO` a role here without checking it isn't already owned by that script.

## Data-access helpers (for Vimal, Thulasi)

Writing a FHIR-shaped record correctly is easy to get wrong by hand: child tables, version
history, provenance, entered-in-error. Helpers take the `AsyncSession` that `tenant_db` gives
the endpoint, never a session of their own, so the clinic settings and the `require()` guard
always apply. Use these instead of touching the ORM models directly from another module's
`repository.py`:

```python
from app.fhir.serializer import to_fhir          # ORM row / history snapshot -> FHIR JSON
from app.db.constraints import patient_column      # which column says "this row's patient"
from app.db.errors import db_error_detail          # map a caught DBAPIError to (status, detail)
```

A full `fhir_store.create/update/entered_in_error/history` helper layer (as sketched in the
original Implementation Guide) is not built yet — this adoption PR is the schema and the
read-only `/fhir` facade only. Flag it if you need it before it exists.

## Rules that never bend

- Every computed column is `STORED` (`persisted=True` on `Computed(...)`); a schema test
  (`tests/test_db_rules.py::test_no_virtual_generated_columns`) fails otherwise (D34 — PostgreSQL
  18 defaults to `VIRTUAL`, which cannot be indexed).
- IDs are UUIDv4 everywhere (D29) — `uuidv7()` is not adopted; it exposes creation time.
- Collation is C.UTF-8 in every environment (D33).
- No DELETE on resource tables; corrections use `entered-in-error`.
- Schema changes only through a new Alembic revision; never edit `sql_0001/`/`sql_0002/`.
- Regenerate `sql/*.sql` from the models (`python -m app.db.tools.gen_db_rules`) before writing
  a new migration's embedded SQL — never hand-edit the generated files.
