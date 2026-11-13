# Performance baseline (`perf_baseline.py`)

A repeatable timing of the main reads and writes on a realistic amount of synthetic data, the first part of D35's load test. It runs by hand on a development machine, never in CI or on a server.

## What it does

1. Creates its own database, `shri_perf_<UTC time>_<6 hex>`, owned by `shri_migrator`, collation C.UTF-8 (D33), and runs `sql/00_extensions.sql` as the master login. It then sets that login to work as `shri_migrator` in this database only (`ALTER ROLE ... IN DATABASE`, removed with the database), so the migration and the seed run as `shri_migrator`, and migrates to head.
2. Loads the starter and demo layers and adds a third clinic, then tops each of the 3 clinics up to **2,000 patients** (the demo clinic keeps its demo patients and gets the rest). Every added patient has two past visits with three vital signs each. The data is generated, never real: names with digits (for example `Brightwater412 Riley527`), `555-01xx` phone numbers, `PERF<clinic>-<n>` MRNs. Patient *n* of clinic *c* comes from its own fixed seed, so every run builds the same population.
3. Times each operation **200 times**, then prints the median and the p95 in milliseconds:

| Operation | What is timed | As |
|---|---|---|
| patient search | `POST /patients/search`: half a name prefix (`criteria.query`, D117), half an MRN | the front desk (`fd`) |
| chart read | `GET` the patient, their vital signs and their encounters, one after another | the doctor (`md`) |
| free times | `GET /slots` at the demo clinic's main office, on a day of the coming week | the front desk |
| create visit | `fhir_store.create_encounter`, committed | `shri_app`, the clinic set |
| file result | `fhir_store.record_report` for a lipid panel with three results, committed (its order is written first, untimed) | `shri_app`, the clinic set |

   The API calls run the real app in-process, as `shri_app`, with `tenant_db` setting the clinic, so row-level security and the audit writes are part of every number.
4. Times every SQL statement too, and runs `EXPLAIN (ANALYZE, BUFFERS)` on the five slowest reads by p95, as `shri_app` in the demo clinic, with the parameters of their slowest run.
5. Drops its database, after a failure too. `--keep` keeps it, to look at a plan by hand.

## How to run it

From `backend/`, with the project's virtual environment:

```bash
ENVIRONMENT=development PERF_ADMIN_DATABASE_URL=... python -m app.db.tools.perf_baseline
```

`PERF_ADMIN_DATABASE_URL` is the local master login (`postgresql+psycopg://...`), set from your own environment and never written into a file or printed. Options: `--patients N` per clinic (default 2000), `--runs N` (default 200), `--keep`. A full run takes a few minutes; most of it is the population.

## Safety

- It runs only where `ENVIRONMENT` is `development` or `test`, and never where `SHRI_DEMO` is `true`. Unset counts as production and is refused.
- It touches no database but the one it created. Creating and dropping both check the name against `shri_perf_<14 digits>_<6 hex>` first, so `shri_health`, `postgres`, `keycloak` and the templates can never match.
- It is not a test: `tests/test_perf_baseline.py` covers only the guards and the generator's determinism, with no database, so the default test run and CI never build a population.

## The earlier baseline (13 Nov 2026)

Measured on a laptop with PostgreSQL 18, 3 clinics × 2,000 patients, 200 runs each, as above, except that patient search then used the family and given criteria (before D117). This tool prints these next to each new run.

| Operation | Median ms | p95 ms |
|---|---|---|
| patient search | 26.5 | 66.0 |
| chart read (all three reads) | 49.6 | 58.4 |
| free times | 12.7 | 15.9 |

Create visit and file result were not measured then; this tool adds them. That run's population also had a blood-pressure panel at each visit and booked appointments in the coming week, so its chart-read and free-times numbers are not directly comparable with this tool's.

First run of this tool (13 Nov 2026, the same laptop, main at 0022): patient search 32.1 / 78.1, chart read 23.6 / 46.8, free times 5.7 / 7.5, create visit 43.3 / 52.1, file result 64.3 / 90.1 (median / p95 ms).

## Not covered yet

- **Claims.** D35 also asks for create-claim timing and 20,000 claims; the claim write path isn't built yet, so this tool neither creates nor times claims.
- **Volume.** D35's full shape (20,000 visits and 200,000 observations) is larger than this population (about 12,000 visits and 36,000 vital signs); `--patients` raises it.
- **One machine, one process.** Numbers from a laptop are for comparing runs on the same machine, not a server sizing.
