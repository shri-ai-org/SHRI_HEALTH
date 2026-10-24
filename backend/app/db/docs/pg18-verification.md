# Sam's schema (PR #9) on PostgreSQL 17 vs 18 — verification report

**Status:** PROPOSED for review. Produced in a read-only check against `sam/fhir-schema-proposal`
(no commits, pushes, comments or PRs made). This locks nothing.

**Scope note:** this report assumes the premise stated for this check — ADR-0011 adopted, HAPI
retired, PostgreSQL 18 as the lock target. As of this check, ADR-0011 does not exist in the repo
and PR #9 is still in draft, titled by its own author "do not merge, conflicts with D1." That is a
separate, standing issue (see the Stage 1 review) and is not re-litigated here — this report is
purely the technical PG17-vs-18 verification, which is useful regardless of how that question
resolves.

## Environment

No Docker and no passwordless sudo were available in the verification environment; only
PostgreSQL 16 was pre-installed. Both target versions were built from official source tarballs in
user space (no root), with build-time dependencies (bison, flex, m4, pkgconf, readline, zlib,
libxml2) fetched via `apt-get download` + `dpkg-deb -x` into a local prefix — no system packages
were installed or modified.

| Item | 17 | 18 | Source |
|---|---|---|---|
| Version built | 17.11 | 18.6 | ftp.postgresql.org source index (latest minors at time of check) |
| Configure flags (identical) | `--without-icu --with-readline --with-zlib --with-libxml --with-openssl` | same | — |
| Locale/collation provider | **libc**, not ICU | **libc**, not ICU | Deviation, see below |
| Data checksums | on | on | `current_setting('data_checksums')` |
| Encoding | UTF8 | UTF8 | `current_setting('server_encoding')` |
| Collation | C.UTF-8 (libc) | C.UTF-8 (libc) | `pg_database.datcollate/datctype/datlocprovider` |
| Timezone | UTC | UTC | `current_setting('TimeZone')`, set explicitly in `postgresql.conf` |
| `password_encryption` | scram-sha-256 | scram-sha-256 | `current_setting('password_encryption')` |
| `pg_hba.conf` | no `md5`/`trust` lines; `scram-sha-256` throughout | same | file inspection |
| `pg_authid` MD5 hashes | 0 | 0 | `select count(*) from pg_authid where rolpassword like 'md5%'` |
| CPU / memory limits | **not enforced** (no cgroups/Docker available) | same | Deviation, see below |

**Deviations from the ground rules, and why:**
- **ICU dropped.** The extracted ICU static archive failed to link against PG's C-only link step
  (`undefined reference ... C++ ABI symbols`, `DSO missing from command line`) — an artifact of
  linking a Debian-packaged ICU `.a` outside its normal install, unrelated to anything in Sam's
  schema. Rather than chase that further, both clusters were built `--without-icu` and use the
  **libc** provider identically. This still satisfies "same locale and collation provider for
  both" — it just means ICU-specific collation behavior was not exercised. If production actually
  plans to use ICU collation, that should be verified separately.
- **CPU/memory limits not enforced.** No Docker, no root → no cgroup control. The two clusters
  were run sequentially, never concurrently (satisfying the timing-section rule independently of
  this), on a 12-core/15 GB host. Any timing numbers in this report (there are only incidental
  ones; see §5) are **not** controlled-resource measurements.

## 0. Baseline on 17

`00_extensions.sql` → `alembic upgrade head` → `downgrade base` → `upgrade head` → `alembic check`
→ full suite, all against PG 17.11:

- Migrations: clean up/down/up, no errors.
- `alembic check`: **No new upgrade operations detected.**
- Tests: **42 passed** (34 in `test_db_rules.py` + 8 in `test_fhir_facade.py`, matching the
  README's claim exactly).
- Sam's branch states it was verified on **PostgreSQL 17.7** (`proposals/fhir-schema/README.md`).
  This check used 17.11, the latest 17.x minor; no behavior difference was observed.

## 1. Environment (18) — dependency versions and their PG18 support, sourced

| Dependency | Resolved version (from `requirements.txt` constraints, installed via pip) | PG18 support | Source |
|---|---|---|---|
| `psycopg[binary]>=3.2` | 3.3.6 | PG18 libpq support added at **3.2.8**; current 3.3.x supersedes it | [psycopg release notes](https://www.psycopg.org/psycopg3/docs/news.html) |
| `sqlalchemy[asyncio]>=2.0.36,<2.1` | **2.0.55** (the pin excludes 2.1.x, so pip resolves to the latest 2.0.x) | 2.0.55 added PG18 temporal-FK reflection and support for PG18's VIRTUAL generated-column default | [SQLAlchemy 2.0 changelog](https://www.sqlalchemy.org/changelog/CHANGES_2_0_40) |
| `alembic>=1.14` | 1.20.1 | No explicit "NOT ENFORCED" or PG18 changelog entry found — **not stated** by Alembic; verified empirically instead (§3) | searched Alembic/SQLAlchemy issue trackers, nothing definitive |

No bison/flex/ICU version claims apply to the application dependency stack — noted here only
because they blocked the PG18 *build* itself (§Environment).

## 2. Extensions and hosting

| Extension | Tech Arch pin | Built/tested version | PG18 behavior | Source |
|---|---|---|---|---|
| pgcrypto | — | bundled (17.11/18.6 contrib) | builds and installs clean on both | build log |
| pg_trgm | — | bundled | clean on both | build log |
| btree_gist | — | bundled | clean on both | build log |
| pgvector | **0.8.7** | 0.8.7 (built from source for both) | PG18 support added at 0.8.1 (RC1); **0.8.2** fixed EXPLAIN output on PG18; **0.8.3** fixed a Hamming/Jaccard distance performance regression specific to PG18 — so 0.8.7 carries both fixes | [pgvector CHANGELOG](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md) |
| pg_textsearch | **1.5.0** | not installed — **Sam's schema does not reference it anywhere** (only `pg_trgm` is used, for fuzzy name/compendium search) | real extension (Timescale, BM25 full-text search), standalone — does **not** require TimescaleDB; v1.5.0 itself is stated as verified on **PostgreSQL 17**, not 18 | [timescale/pg_textsearch v1.5.0](https://github.com/timescale/pg_textsearch/releases/tag/v1.5.0); PG18 compatibility per extension docs |

**Managed hosting (Amazon RDS for PostgreSQL 18.6, the current minor):**

| Extension | RDS-supported version on PG18 | Gap vs. Tech Arch pin |
|---|---|---|
| pgvector | **0.8.2** | Tech Arch pins 0.8.7; RDS is 5 patch releases behind, and is missing the 0.8.3 Hamming/Jaccard PG18 fix |
| pg_trgm | 1.6 | none |
| btree_gist | 1.8 | none |
| pgcrypto | 1.4 | none |
| pg_textsearch | **not listed / not supported** | Tech Arch pins it for RAG retrieval (AI-02/RAG, P1 scope per Sam's "Open items"); if the production target is RDS, this extension is not available there at all — built-in `tsvector`/`tsquery` would have to substitute, or hosting would need to move to self-managed/EC2/Aurora with a custom extension |

Source: AWS RDS for PostgreSQL extension support documentation (queried for the 18.6 minor).

**Self-hosted fallback — pgBackRest:** current stable release is **2.60.0** (2026-10-18). PG18
support was added in 2.55.0 (April 2025, ahead of PG18's own beta); nothing about PG18's eventual
GA changed that. 2.60.0 fully supports PG18. [pgBackRest 2.60.0 release](https://www.postgresql.org/about/news/pgbackrest-2600-released-3416/)

## 3. Migrations and tests (18)

| Check | 17 | 18 | Pass/fail | Action |
|---|---|---|---|---|
| `alembic upgrade head` | clean | clean | **PASS** | — |
| `alembic downgrade base` | clean | clean | **PASS** | — |
| `alembic upgrade head` (2nd) | clean | clean | **PASS** | — |
| `alembic check` | no drift | **no drift** | **PASS** | PG18's new `pg_constraint` NOT NULL representation and `NOT ENFORCED` support did not produce any detected drift against Sam's models — checked directly, not inferred |
| Full test suite | 42/42 passed | 42/42 passed | **PASS** | identical result set on both versions |
| Tests run as `shri_app` (not superuser, `NOBYPASSRLS`) | confirmed (`rolsuper=f`, `rolbypassrls=f`) | confirmed (`rolsuper=f`, `rolbypassrls=f`) | **PASS** | — |

No diffs of any kind between the two runs.

## 4. PG18 behavior changes

**AFTER triggers:**

| | 17 | 18 |
|---|---|---|
| AFTER, not deferrable | 107 BEFORE + 77 AFTER (not deferrable) | identical |
| AFTER, deferrable + initially deferred | 30 | identical |
| `SECURITY DEFINER` trigger functions | 1 (`shri_fhir_history`) | identical |

- No trigger or RLS policy function reads the built-in `current_user` or `session_user` anywhere
  in the generated SQL (`grep` across `sql/*.sql`: zero matches). Identity/tenant context flows
  entirely through two session GUCs set by the application: `app.current_tenant_id` (RLS) and
  `app.current_user_id` (provenance, inside `shri_fhir_history`). **This means the DB role
  executing a statement (`shri_app` vs. `shri_migrator`) cannot affect trigger behavior** — the
  trigger logic has no role-conditional branching. This is unchanged between 17 and 18.
- This also means the "can the role change between queuing and COMMIT" question is moot for these
  deferred triggers: they depend on the session GUC value at COMMIT time, not on which role holds
  the connection. The open risk is an **application-layer** one (does the app keep the `SET LOCAL`
  GUC correctly scoped to the whole transaction including deferred commit-time work?), not a
  database or PG17-vs-18 one.
- I verified this via source and catalog inspection (identical trigger definitions and function
  bodies on both clusters, confirmed through the already-passing 42-test suite run as `shri_app`
  on both versions). I did **not** additionally run a live manual insert as `shri_migrator` against
  a hand-built FHIR row — constructing a valid multi-FK clinical row via raw SQL was out of
  proportion to what the source inspection already shows; flagging this as a partial check rather
  than claiming more than was done.
- History lands at commit and attribution is correct: confirmed by the passing
  `test_db_rules.py` suite (which exercises exactly this), identically on both versions.

**Generated columns:**

| Table.column | `pg_attribute.attgenerated` | Indexed? | 17 | 18 |
|---|---|---|---|---|
| `audio_recording.consent_kind` | `s` (STORED) | no | confirmed | confirmed |
| `knowledge_chunk.content_tsv` | `s` (STORED) | **yes** — `ix_knowledge_chunk_tsv` GIN index | confirmed | confirmed |
| `user_alert_suppression.rule_is_suppressible` | `s` (STORED) | no | confirmed | confirmed |

All three are explicitly `STORED` in every DDL path checked (`shri/models/.../*.py` via
`Computed(..., persisted=True)`, the generated `sql/01_schema.sql`, and the frozen
`alembic/versions/sql_0001/01_schema.sql`) — verified both statically (source) and at the catalog
level (`pg_attribute`) on both PG versions. **No implicit-VIRTUAL risk exists today.**

This matters because PG18 changed the *default* when `STORED`/`VIRTUAL` is omitted: PG17 only
supports `STORED` and requires the keyword; PG18 adds `VIRTUAL` and makes it the **default if the
keyword is omitted**. Sam's generator (`tools/gen_db_rules.py`) always emits `STORED` explicitly,
so this is safe today — but it is only safe because every current call site sets
`persisted=True`. **Action for Anand:** add a lint/review check that any new `Computed(...)` column
must set `persisted=True`, since nothing in the schema would catch a future omission until a GIN
index (which PG18 forbids on `VIRTUAL` columns) silently failed to build.

**`uuidv7()`:**

- UUIDs are generated **Python-side** today: `default=uuid.uuid4` in `shri/db/base.py`
  (`UUIDPKMixin`, the primary-key mixin used everywhere). A second, separate site exists:
  `event_uuid` in `shri/models/admin/platform.py` uses `server_default=text("gen_random_uuid()")`
  — a *different* UUID (v4, server-side) for a secondary audit field, not the primary key. Any
  move to `uuidv7()` needs to address both sites, not just the one `base.py:12` comment calls out.
- **Throwaway experiment** (separate worktree, `shri/db/base.py` only, never pushed, deleted after
  this check): switched `UUIDPKMixin.id` to `server_default=text("uuidv7()")`, regenerated DDL
  (`tools/gen_db_rules.py`), applied the regenerated `sql/*.sql` directly to a scratch PG18
  database (`uuidv7()` doesn't exist on PG17, so this was PG18-only by necessity), and reran the
  full suite.
- **Result: 42/42 tests still passed.** No functional breakage from the switch itself.
- Confirmed the generated IDs are real, well-formed UUIDv7:
  `select uuid_extract_timestamp(id), uuid_extract_version(id) from tenant` returned version `7`
  and the exact wall-clock insert time (`2026-10-23 06:24:03.087+00`), to the millisecond.
- **IDs are exposed outside the database, extensively:** every FHIR facade path
  (`/{rtype}/{rid}`, `/{rtype}/{rid}/_history/{vid}`) and every generated admin CRUD path
  (`/{table}/{row_id}`) carries the raw row ID in the URL. **Switching to `uuidv7()` means every
  such URL — every patient, condition, document, claim, file — leaks that record's exact creation
  timestamp to anyone who can see the ID, independent of whether they're authorized to read the
  resource itself**, since timestamp extraction from a UUIDv7 needs no database access at all (it's
  a fixed bit-layout). This is a real trade-off to put in front of Sena/Anand/Vimal explicitly
  before adopting `uuidv7()`, not just a technical curiosity — for a HIPAA system, "when was this
  diagnosis/document created" is itself sensitive metadata in some contexts (e.g., timing of a
  sensitive diagnosis, or of a C-CDA import).

## 5. Indicative timing — not run

**No synthetic data loader exists on `sam/fhir-schema-proposal`.** What's there is
`tests/builders.py` (small single-chart builders used by the 42-test suite, not a bulk loader) and
`sql/95_seed.sql` (reference/code-system data, ~280 rows, not patient volume). Per your ground
rule — *"only if a synthetic data loader exists on the branch; if not, stop and ask me before
building one"* — **I did not build one.** Let me know if you want me to build a minimal loader (and
roughly what row-count/tenant-count shape you want it to target) before I run the three timed
transactions (create visit, file result, create claim) on both versions.

## 6. Summary

| # | Check | 17 | 18 | Pass/fail | Action |
|---|---|---|---|---|---|
| 0 | Baseline: migrations up/down/up, `alembic check`, 42 tests | pass | — | **PASS** | none |
| 1 | Env: checksums, scram-sha-256, UTC, no md5/trust, no MD5 hashes | pass | pass | **PASS** | none |
| 1 | psycopg/SQLAlchemy/Alembic resolve to PG18-aware versions | n/a | 3.3.6 / 2.0.55 / 1.20.1 | **PASS** | none; Alembic's NOT ENFORCED support specifically is "not stated" by its docs, resolved empirically in #3 instead |
| 2 | pgcrypto/pg_trgm/btree_gist build and install | pass | pass | **PASS** | none |
| 2 | pgvector 0.8.7 matches Tech Arch pin, builds, PG18-safe | pass | pass | **PASS** | none for self-hosted; **RDS only ships 0.8.2 for PG18** — confirm hosting target before relying on 0.8.7-specific fixes |
| 2 | pg_textsearch (Tech Arch pin 1.5.0) | n/a — unused | n/a — unused | **N/A today** | real extension, PG18-capable, but **not on RDS**; confirm with Sam/Sena whether RAG retrieval (P1) depends on it before picking a hosting target |
| 2 | pgBackRest PG18 support | n/a | 2.60.0, fully supported | **PASS** | none |
| 3 | Migrations up/down/up, `alembic check`, full suite, as `shri_app` | pass | pass, identical | **PASS** | none |
| 4 | Trigger inventory identical; no role-dependent logic | pass | pass | **PASS** | partial: no live `shri_migrator` functional insert performed (see note) |
| 4 | Generated columns all explicit `STORED`, no VIRTUAL-default risk today | pass | pass | **PASS** | add a review/lint rule requiring `persisted=True` on all future `Computed()` columns |
| 4 | `uuidv7()` throwaway: functional | n/a | 42/42 pass | **PASS (functional)** | decide before adopting: two UUID-generation sites, not one; real timestamp-leak-via-URL trade-off to put to Sena/Anand/Vimal |
| 5 | Indicative timing | — | — | **NOT RUN** | no synthetic loader exists; stopped per your ground rule — awaiting your go-ahead to build one |

**PostgreSQL 18 is ready for the schema lock, from a schema-correctness standpoint** — migrations,
constraints, RLS, triggers, generated columns and the full test suite behave identically to 17,
and the one real PG18 behavior change that could bite (implicit `VIRTUAL` generated columns) is
already handled correctly everywhere it currently applies. What's **not** resolved by this check,
and shouldn't be read as resolved: (1) the hosting target — if it's RDS, the pgvector pin needs to
drop to what RDS actually ships (0.8.2) or the plan needs non-RDS hosting, and `pg_textsearch`
isn't available on RDS PostgreSQL 18 at all; (2) the `uuidv7()` switch is not yet decided, and now
has a concretely demonstrated privacy trade-off attached to it, not just a performance one; (3) the
timing section is still outstanding, pending either a synthetic loader you want built or your
decision to skip it for now.

**To re-check after the agreed three-schema split (clinical / admin / audit, per-service roles):**
- The RLS setting names this check observed (`app.current_tenant_id`, `app.current_user_id`) and
  the `shri_app` / `shri_migrator` role boundary were all tested against a **single** schema.
  Splitting into three schemas with per-service roles will change grants, search_path, and
  possibly which role owns which triggers — none of that is validated by this report.
  Re-run §3 and §4's trigger/role checks after the split, not before.
- The generated-column and `uuidv7()` findings are schema-location-independent and should still
  hold, but re-verify the GIN index on `content_tsv` still builds correctly if `knowledge_chunk`
  moves to a different schema than today's RLS/role setup assumes.
