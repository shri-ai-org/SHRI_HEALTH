-- Run once per database as a superuser / rds_superuser before `alembic upgrade head`.
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), digest() for hash chains
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy name / compendium search
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- appointment double-booking exclusion
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector, RAG embeddings

-- Roles: migrations run as shri_migrator (table owner); the API connects as shri_app, which
-- cannot bypass row-level security.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shri_app') THEN
    CREATE ROLE shri_app LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shri_migrator') THEN
    CREATE ROLE shri_migrator LOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT CREATE, USAGE ON SCHEMA public TO shri_migrator;
