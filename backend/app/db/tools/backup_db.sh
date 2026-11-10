#!/bin/bash
# Nightly logical backup of the self-managed PostgreSQL (the demo and test servers; RDS has its own,
# D30). Usage: backup_db.sh <database> <backup dir>
#
# Runs pg_dump -Fc as the master user, which row security doesn't hide rows from, so the dump has
# every clinic's rows. Connection settings come from libpq's environment (PGHOST, PGUSER,
# PGPASSFILE ...), never the command line. On a Docker host, run the tools inside the database
# container instead:
#   PG_DUMP="docker compose -p shri-deploy exec -T postgres pg_dump -U postgres" \
#   PG_RESTORE="docker compose -p shri-deploy exec -T postgres pg_restore" backup_db.sh shri /var/backups/shri
#
# The file is written under a temporary name, checked with pg_restore --list, then renamed, mode
# 600. KEEP (default 14) newest dumps of this database are kept; older ones are removed. The file
# holds every clinic's data: copy it off the server, encrypted (the scheduler's job, not this one).
# It sits unencrypted on disk until then, which is fine for synthetic data only: before real data,
# encrypt it as it is written (for example piped to age with a public key) so no plain copy lands.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: backup_db.sh <database> <backup dir>" >&2; exit 2; }
DB=$1 DIR=$2 KEEP=${KEEP:-14}
PG_DUMP=${PG_DUMP:-pg_dump} PG_RESTORE=${PG_RESTORE:-pg_restore}
umask 077
mkdir -p "$DIR"
out="$DIR/$DB-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT
start=$(date +%s)
$PG_DUMP -Fc "$DB" > "$tmp"
entries=$($PG_RESTORE --list < "$tmp" | grep -vc '^;')
[ "$entries" -gt 0 ] || { echo "backup_db: $tmp lists no entries" >&2; exit 1; }
mv "$tmp" "$out"
trap - EXIT
echo "backup_db: $out ($(du -h "$out" | cut -f1), $entries entries, $(( $(date +%s) - start )) s)"
ls -1t "$DIR/$DB"-*.dump | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f -- "$old" && echo "backup_db: removed $old (older than the newest $KEEP)"
done
