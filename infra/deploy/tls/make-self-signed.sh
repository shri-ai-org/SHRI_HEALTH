#!/bin/sh
# A self-signed certificate for a local hostname (laptop fallback, rehearsals): TLS mode
# `self-signed` in deploy.sh. Never for a host on the internet: there, TLS mode `provided` uses a
# real certificate for the real domain.
#
#   sh infra/deploy/tls/make-self-signed.sh shri.localhost /path/outside/the/repo/tls
#
# Writes server.crt (to trust in the browser or pass to curl --cacert) and server.key (mode 600).
set -eu
host="${1:?hostname, e.g. shri.localhost}"
dir="${2:?output folder, outside the repository}"

case "$host" in *[!A-Za-z0-9.-]*|'') echo "not a hostname: $host" >&2; exit 1 ;; esac
mkdir -p "$dir"
chmod 700 "$dir"
if [ -f "$dir/server.crt" ] && [ -f "$dir/server.key" ]; then
    echo "Certificate already exists in $dir"
    exit 0
fi
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 397 \
    -subj "/CN=$host" \
    -addext "subjectAltName=DNS:$host,DNS:localhost,IP:127.0.0.1" \
    -keyout "$dir/server.key" -out "$dir/server.crt" 2>/dev/null
chmod 600 "$dir/server.key"
chmod 644 "$dir/server.crt"
echo "Created $dir/server.crt and server.key for $host"
