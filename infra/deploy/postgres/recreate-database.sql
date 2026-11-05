-- The reset split's first half (deploy.sh reset): drop the demo's application database and
-- create it again empty, with the database-level setup that initdb/10-service-roles.sh gives a
-- new one. Run by the master user, connected to the `postgres` database, with -v target=...
-- (not DBNAME: psql sets that itself to the database it is connected to). Synthetic data only:
-- deploy.sh runs it only on a demo host.
--
-- The service roles belong to the cluster, not the database, so they and their passwords
-- survive; only the per-database part is redone. The extensions (00_extensions.sql) follow as
-- the master user, then the migrations and the demo data (python -m app.db.seed reset).

-- Never the server's own databases or Keycloak's (it shares this server): the raised error
-- stops the script (ON_ERROR_STOP) before anything is dropped.
SELECT format('DO $g$ BEGIN RAISE EXCEPTION %L; END $g$', 'refusing to drop ' || :'target')
WHERE :'target' IN ('postgres', 'template0', 'template1', 'keycloak') \gexec

-- FORCE ends any connection still open (the API and the worker are stopped first).
DROP DATABASE IF EXISTS :"target" WITH (FORCE);
-- As on RDS (infra/terraform/README.md): UTF-8 with the builtin C.UTF-8 locale (D33).
CREATE DATABASE :"target" TEMPLATE template0 ENCODING 'UTF8'
    LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' OWNER shri_migrator;
REVOKE ALL ON DATABASE :"target" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"target"
    TO shri_migrator, shri_app, shri_fhir_reader, shri_integration, shri_reporting,
       shri_maintenance, shri_portal, shri_public;

\connect :"target"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO shri_migrator;
