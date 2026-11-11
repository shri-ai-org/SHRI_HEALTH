#!/bin/sh
# Puts one secret into the test server's OpenBao, where the API reads it at startup
# (KV v2, secret/shri-health/api; core/settings). For example the Claude API key:
#
#   sh infra/deploy/openbao/set-secret.sh /etc/shri/deploy.env CLAUDE_API_KEY
#
# Run it yourself, on the server, in your own terminal: never through an assistant, a CI job or
# a script that logs. The value is typed hidden, travels only through a pipe into the OpenBao
# container, and is never printed, written to disk, put on a command line (where `ps` would show
# it) or kept in shell history. Other values at that path are kept (patch). Then run
# `deploy.sh up` again so the API reads it. The admin token comes from the state file that
# deploy.sh wrote (mode 600) and goes the same way.
set -eu

[ $# -eq 2 ] || { echo "usage: $0 <settings file> <NAME, e.g. CLAUDE_API_KEY>" >&2; exit 2; }
case "$2" in *[!A-Z0-9_]*|'') echo "NAME is upper case letters, digits and _" >&2; exit 2 ;; esac
NAME=$2
SETTINGS_DIR=$(cd "$(dirname "$1")" && pwd)
STATE_DIR=$(sed -n 's/^SHRI_STATE_DIR=//p' "$1" | tail -1)
STATE="${STATE_DIR:-$SETTINGS_DIR/shri-state}/openbao.env"
PROJECT=$(sed -n 's/^SHRI_PROJECT=//p' "$1" | tail -1)
case "${PROJECT:=shri-deploy}" in shri-*) ;; *) echo "SHRI_PROJECT must start with shri-" >&2; exit 2 ;; esac
BAO="$PROJECT-openbao-1"  # deploy.sh's compose project (SHRI_PROJECT)

docker ps --format '{{.Names}}' | grep -qx "$BAO" || { echo "OpenBao isn't running ($BAO): run deploy.sh up" >&2; exit 1; }
if docker exec "$BAO" sh -c 'BAO_ADDR=http://127.0.0.1:8200 bao status' | grep -q 'Sealed *true'; then
    echo "OpenBao is sealed (after a restart): run deploy.sh up first, which unseals it" >&2
    exit 1
fi
[ -r "$STATE" ] || { echo "Can't read $STATE (run as the user that runs deploy.sh)" >&2; exit 1; }

bao() {  # `bao "$@"` in the container; the admin token arrives as the first line of stdin
    docker exec -i "$BAO" sh -c 'read -r BAO_TOKEN; export BAO_TOKEN BAO_ADDR=http://127.0.0.1:8200; exec bao "$@"' bao "$@"
}
token() { sed -n 's/^BAO_ROOT_TOKEN=//p' "$STATE"; }

printf '%s: ' "$NAME (typed or pasted, nothing shows)"
stty -echo; trap 'stty echo' EXIT INT TERM
IFS= read -r VALUE
stty echo; echo
[ -n "$VALUE" ] || { echo "Nothing typed; nothing stored" >&2; exit 1; }

if token | bao kv metadata get -mount=secret shri-health/api >/dev/null 2>&1; then
    { token; printf '%s' "$VALUE"; } | bao kv patch -mount=secret shri-health/api "$NAME=-" >/dev/null
else
    { token; printf '%s' "$VALUE"; } | bao kv put -mount=secret shri-health/api "$NAME=-" >/dev/null
fi
VALUE=
LEN=$(token | bao kv get -mount=secret -field="$NAME" shri-health/api | wc -c)
echo "Stored $NAME in OpenBao ($LEN characters; the value is not shown). Run deploy.sh up so the API reads it."
