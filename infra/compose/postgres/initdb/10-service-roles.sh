#!/usr/bin/env bash
# Creates the service roles of DECISIONS D23 in the local and CI database, on first start only.
# Grants on schemas and tables come from Anand's migrations, not from here. On Amazon RDS the
# master role and shri_migrator do this instead (ADR-0012).
#
#   shri_migrator     owns the database; runs migrations only, never the API
#   shri_app          the API
#   shri_fhir_reader  the read-only /fhir API
#   shri_integration  the partner worker
#   shri_reporting    read-only reports
#   shri_maintenance  runs the scheduled purge functions only; no table access (D23, #52/#64)
#
# No role is a superuser or may bypass row-level security.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v migrator_pw="${SHRI_MIGRATOR_PASSWORD:?}" \
    -v app_pw="${SHRI_APP_PASSWORD:?}" \
    -v fhir_reader_pw="${SHRI_FHIR_READER_PASSWORD:?}" \
    -v integration_pw="${SHRI_INTEGRATION_PASSWORD:?}" \
    -v reporting_pw="${SHRI_REPORTING_PASSWORD:?}" \
    -v maintenance_pw="${SHRI_MAINTENANCE_PASSWORD:?}" <<'SQL'
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE ROLE shri_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
    PASSWORD :'migrator_pw';
ALTER DATABASE :"DBNAME" OWNER TO shri_migrator;
ALTER SCHEMA public OWNER TO shri_migrator;

CREATE ROLE shri_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
    PASSWORD :'app_pw';
CREATE ROLE shri_fhir_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
    PASSWORD :'fhir_reader_pw';
CREATE ROLE shri_integration LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
    PASSWORD :'integration_pw';
CREATE ROLE shri_reporting LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
    PASSWORD :'reporting_pw';
CREATE ROLE shri_maintenance LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
    PASSWORD :'maintenance_pw';

GRANT CONNECT ON DATABASE :"DBNAME"
    TO shri_migrator, shri_app, shri_fhir_reader, shri_integration, shri_reporting,
       shri_maintenance;
SQL
