#!/bin/sh
# One shot (keycloak-db in the deploy overlay): Keycloak's own database and login role, in the same
# PostgreSQL as ours but apart from it. The role owns only its database: no access to the clinical,
# admin or audit schemas, no superuser, no BYPASSRLS. Safe to run again; the password follows
# KEYCLOAK_DB_PASSWORD. Runs as the PostgreSQL master user (POSTGRES_USER), as RDS's would.
set -eu
: "${KEYCLOAK_DB_PASSWORD:?}"

until pg_isready -q; do sleep 1; done

# The password reaches psql through its environment (\getenv), never on a command line.
psql -v ON_ERROR_STOP=1 -q <<'SQL'
\getenv pw KEYCLOAK_DB_PASSWORD
SELECT format('CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak') \gexec
SELECT format('ALTER ROLE keycloak PASSWORD %L', :'pw') \gexec
SELECT 'CREATE DATABASE keycloak OWNER keycloak'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'keycloak') \gexec
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
echo "keycloak database ready"
