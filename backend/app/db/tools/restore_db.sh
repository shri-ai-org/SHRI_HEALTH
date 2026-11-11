#!/bin/bash
# Restore a backup_db.sh dump into a new database on the self-managed PostgreSQL.
# Usage: RESTORE_CONFIRM=<target> restore_db.sh <dump file> <target database>
#
# Drops and recreates <target> with the deploy kit's recreate-database.sql (C.UTF-8, owner
# shri_migrator, the roles' CONNECT), then pg_restore --exit-on-error as the master user, then
# prints the head, the patient count and any table without forced row security. Refuses postgres,
# template0, template1 and keycloak, and any run without RESTORE_CONFIRM naming the target.
# On a Docker host, set PSQL and PG_RESTORE as backup_db.sh describes (both read stdin here).
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: RESTORE_CONFIRM=<target> restore_db.sh <dump> <target>" >&2; exit 2; }
DUMP=$1 TARGET=$2
PSQL=${PSQL:-psql} PG_RESTORE=${PG_RESTORE:-pg_restore}
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
case "$TARGET" in postgres|template0|template1|keycloak)
    echo "restore_db: refusing to replace $TARGET" >&2; exit 1 ;; esac
[ "${RESTORE_CONFIRM:-}" = "$TARGET" ] || {
    echo "restore_db: set RESTORE_CONFIRM=$TARGET to drop and replace it" >&2; exit 1; }
[ -s "$DUMP" ] || { echo "restore_db: $DUMP is missing or empty" >&2; exit 1; }
start=$(date +%s)
$PSQL -X -q -v ON_ERROR_STOP=1 -v target="$TARGET" -d postgres \
    < "$REPO/infra/deploy/postgres/recreate-database.sql"
$PG_RESTORE --exit-on-error --no-password -d "$TARGET" < "$DUMP"
echo "restore_db: $DUMP into $TARGET in $(( $(date +%s) - start )) s"
$PSQL -X -At -d "$TARGET" -c "SELECT 'head ' || (SELECT version_num FROM admin.alembic_version)
  || ', patients ' || (SELECT count(*) FROM clinical.patient)
  || ', clinic tables without RLS on and forced ' || (SELECT count(*) FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('clinical', 'admin', 'audit')
     AND c.relkind IN ('r', 'p') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
     AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity))"
