#!/usr/bin/env sh
# Creates a self-signed certificate for https://localhost:8443 (local development only).
# Output goes to infra/nginx/certs/, which git ignores.
set -eu

dir="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$dir"

if [ -f "$dir/dev.crt" ] && [ -f "$dir/dev.key" ]; then
    echo "Certificate already exists in $dir"
    exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$dir/dev.key" -out "$dir/dev.crt"
chmod 600 "$dir/dev.key"
chmod 644 "$dir/dev.crt"
echo "Created $dir/dev.crt and dev.key"
