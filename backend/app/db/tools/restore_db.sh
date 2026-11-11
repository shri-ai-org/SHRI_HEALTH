#!/bin/bash
# Restore a backup_db.sh dump into a new database on the self-managed PostgreSQL.
# Usage: RESTORE_CONFIRM=<target> restore_db.sh [-U <user>] <dump file> <target database>
#
# Drops and recreates <target> with the deploy kit's recreate-database.sql (C.UTF-8, owner
# shri_migrator, the roles' CONNECT), then pg_restore --exit-on-error as the master user, then
# prints the head, the patient count and any table without forced row security. Refuses postgres,
# template0, template1 and keycloak, and any run without RESTORE_CONFIRM naming the target.
# The master user is -U's, else libpq's PGUSER (none hard-coded; on the demo server, shri). On a
# Docker host, set PSQL and PG_RESTORE as backup_db.sh describes, both with -e PGPASSWORD (both
# read stdin here), for example PSQL="$DC exec -T -e PGPASSWORD postgres psql".
set -euo pipefail
usage="usage: RESTORE_CONFIRM=<target> restore_db.sh [-U <user>] <dump> <target>"
user=()
while getopts "U:" opt; do
    case "$opt" in U) user=(-U "$OPTARG") ;; *) echo "$usage" >&2; exit 2 ;; esac
done
shift $((OPTIND - 1))
[ $# -eq 2 ] || { echo "$usage" >&2; exit 2; }
DUMP=$1 TARGET=$2
PSQL=${PSQL:-psql} PG_RESTORE=${PG_RESTORE:-pg_restore}
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
case "$TARGET" in postgres|template0|template1|keycloak)
    echo "restore_db: refusing to replace $TARGET" >&2; exit 1 ;; esac
[ "${RESTORE_CONFIRM:-}" = "$TARGET" ] || {
    echo "restore_db: set RESTORE_CONFIRM=$TARGET to drop and replace it" >&2; exit 1; }
[ -s "$DUMP" ] || { echo "restore_db: $DUMP is missing or empty" >&2; exit 1; }
start=$(date +%s)
$PSQL "${user[@]}" -X -q -v ON_ERROR_STOP=1 -v target="$TARGET" -d postgres \
    < "$REPO/infra/deploy/postgres/recreate-database.sql"
$PG_RESTORE "${user[@]}" --exit-on-error --no-password -d "$TARGET" < "$DUMP"
echo "restore_db: $DUMP into $TARGET in $(( $(date +%s) - start )) s"
$PSQL "${user[@]}" -X -At -d "$TARGET" -c "SELECT 'head ' || (SELECT version_num FROM admin.alembic_version)
  || ', patients ' || (SELECT count(*) FROM clinical.patient)
  || ', clinic tables without RLS on and forced ' || (SELECT count(*) FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('clinical', 'admin', 'audit')
     AND c.relkind IN ('r', 'p') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
     AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity))"
