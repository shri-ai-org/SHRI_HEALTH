-- Run once per database, before `alembic upgrade head`.
--
-- On RDS: as the RDS master role (ADR-0012 - RDS has no true Postgres superuser; the master
-- role can CREATE EXTENSION for its allow-listed extensions, which covers all four below).
-- Locally/CI: as the postgres superuser, equivalent in effect.
--
-- Role bootstrap (shri_migrator, shri_app, shri_fhir_reader, shri_integration, shri_reporting)
-- happens OUTSIDE this file: locally/CI via infra/compose/postgres/initdb/10-service-roles.sh
-- (Thulasi); on RDS, by the master role per ADR-0012. This file only creates schemas, installs
-- extensions, and sets search_path - it assumes the five roles already exist and does not
-- create or grant role membership itself, so it never conflicts with that script.

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), digest() for hash chains
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy name / compendium search
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- appointment double-booking exclusion
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector, RAG embeddings (D31: version RDS ships)

-- Three schemas (D23 / ADR-0011 condition 4), owned by shri_migrator so its migrations can
-- create and alter objects in all three without per-object ownership transfers.
CREATE SCHEMA IF NOT EXISTS clinical AUTHORIZATION shri_migrator;
CREATE SCHEMA IF NOT EXISTS admin AUTHORIZATION shri_migrator;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION shri_migrator;

-- Hand-written rule functions (sql/05_prelude.sql, sql/10_rules.sql) live in `public` - they're
-- schema-agnostic utilities shared across all three data schemas, not tied to one of them.
-- Every role that calls them (directly, or via a trigger on a clinical/admin/audit table) needs
-- all three schemas plus public on its search_path so the many unqualified table references
-- inside those hand-written function bodies resolve correctly.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['shri_migrator', 'shri_app', 'shri_integration', 'shri_reporting']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('ALTER ROLE %I SET search_path = clinical, admin, audit, public', r);
    END IF;
  END LOOP;
END $$;
