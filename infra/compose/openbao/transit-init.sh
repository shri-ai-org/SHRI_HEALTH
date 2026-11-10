#!/bin/sh
# Sets up OpenBao's Transit engine and the API's secrets path for the API: on the development server (compose and CI), and on
# the test server's real OpenBao after deploy.sh unseals it (infra/deploy). Never for production,
# which gets a managed OpenBao set up separately.
#
# Needs: BAO_ADDR, BAO_TOKEN (the dev server's root token) and OPENBAO_API_TOKEN (the token the
# API will use). Safe to run again: each step checks first.
#
# The API's token can encrypt and decrypt with `shri-fields` (field encryption), and make and
# unwrap data keys with `shri-files` (file envelope encryption), both in core/crypto.py. It can't
# read or export either key, encrypt with `shri-files`, make data keys with `shri-fields`, use
# another key, or create tokens. It can also read (never write or list) the one KV secret the
# API loads at startup, secret/shri-health/api (core/settings: CLAUDE_API_KEY, Vimal 10 Nov). A
# person puts values there by hand (infra/deploy/README.md), never this script, which only makes
# sure the path exists so the API can start before anyone has stored a value.
set -eu

: "${BAO_ADDR:?}" "${BAO_TOKEN:?}" "${OPENBAO_API_TOKEN:?}"
KEY=shri-fields
FILES_KEY=shri-files
POLICY=shri-api-transit

if ! bao secrets list -format=json | grep -q '"transit/"'; then
    bao secrets enable transit >/dev/null
fi

for name in "$KEY" "$FILES_KEY"; do
    if ! bao read "transit/keys/$name" >/dev/null 2>&1; then
        bao write -f "transit/keys/$name" type=aes256-gcm96 >/dev/null
    fi
done

# The API's startup secrets (KV v2 at secret/; development servers already have it).
if ! bao secrets list -format=json | grep -q '"secret/"'; then
    bao secrets enable -path=secret kv-v2 >/dev/null
fi
if ! bao kv metadata get -mount=secret shri-health/api >/dev/null 2>&1; then
    bao kv put -mount=secret -cas=0 shri-health/api created_by=transit-init >/dev/null
fi

bao policy write "$POLICY" - >/dev/null <<EOF
path "secret/data/shri-health/api" {
  capabilities = ["read"]
}
path "transit/encrypt/$KEY" {
  capabilities = ["update"]
}
path "transit/decrypt/$KEY" {
  capabilities = ["update"]
}
path "transit/datakey/plaintext/$FILES_KEY" {
  capabilities = ["update"]
}
path "transit/decrypt/$FILES_KEY" {
  capabilities = ["update"]
}
EOF

# A fixed token ID from the environment, so the API can be given it without reading it back.
# No default policy (it can't even look itself up), not renewable, and it's not a child of root.
if ! bao token lookup "$OPENBAO_API_TOKEN" >/dev/null 2>&1; then
    bao token create -id="$OPENBAO_API_TOKEN" -policy="$POLICY" -no-default-policy -orphan \
        -renewable=false -ttl=768h >/dev/null
fi

echo "OpenBao ready: Transit keys $KEY and $FILES_KEY, the API's secrets path, the API's token limited to what it needs"
