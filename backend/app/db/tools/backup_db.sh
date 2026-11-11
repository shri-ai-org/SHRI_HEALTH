#!/bin/bash
# Nightly logical backup of the self-managed PostgreSQL (the demo and test servers; RDS has its own,
# D30). Usage: backup_db.sh [-U <user>] <database> <backup dir>
#
# Runs pg_dump -Fc as the master user, which row security doesn't hide rows from, so the dump has
# every clinic's rows. The user is -U's, else libpq's PGUSER: none is hard-coded. The other
# connection settings come from libpq's environment (PGHOST, PGPASSWORD, PGPASSFILE ...), never
# the command line. On the demo server the master user is the deploy kit's POSTGRES_USER, shri,
# and the tools run inside the database container (its password reaches it through the
# environment, never a command line):
#   set -a; . /etc/shri/deploy.env; set +a; export PGPASSWORD="$POSTGRES_PASSWORD"
#   DC="docker compose --env-file /etc/shri/deploy.env -p shri-deploy -f infra/compose/docker-compose.yml -f infra/deploy/docker-compose.deploy.yml"
#   PG_DUMP="$DC exec -T -e PGPASSWORD postgres pg_dump" PG_RESTORE="$DC exec -T postgres pg_restore" \
#     backup_db.sh -U "$POSTGRES_USER" "$POSTGRES_DB" /var/backups/shri
#
# The file is written under a temporary name, checked with pg_restore --list, then renamed, mode
# 600. KEEP (default 14) newest dumps of this database are kept; older ones are removed. The file
# holds every clinic's data: copy it off the server, encrypted (the scheduler's job, not this one).
# It sits unencrypted on disk until then, which is fine for synthetic data only: before real data,
# encrypt it as it is written (for example piped to age with a public key) so no plain copy lands.
set -euo pipefail
usage="usage: backup_db.sh [-U <user>] <database> <backup dir>"
user=()
while getopts "U:" opt; do
    case "$opt" in U) user=(-U "$OPTARG") ;; *) echo "$usage" >&2; exit 2 ;; esac
done
shift $((OPTIND - 1))
[ $# -eq 2 ] || { echo "$usage" >&2; exit 2; }
DB=$1 DIR=$2 KEEP=${KEEP:-14}
PG_DUMP=${PG_DUMP:-pg_dump} PG_RESTORE=${PG_RESTORE:-pg_restore}
umask 077
mkdir -p "$DIR"
out="$DIR/$DB-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT
start=$(date +%s)
$PG_DUMP "${user[@]}" -Fc "$DB" > "$tmp"
entries=$($PG_RESTORE --list < "$tmp" | grep -vc '^;')
[ "$entries" -gt 0 ] || { echo "backup_db: $tmp lists no entries" >&2; exit 1; }
mv "$tmp" "$out"
trap - EXIT
echo "backup_db: $out ($(du -h "$out" | cut -f1), $entries entries, $(( $(date +%s) - start )) s)"
ls -1t "$DIR/$DB"-*.dump | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f -- "$old" && echo "backup_db: removed $old (older than the newest $KEEP)"
done
