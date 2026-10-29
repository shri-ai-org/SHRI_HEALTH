#!/bin/sh
# Sets up OpenBao's Transit engine for the API, on the DEVELOPMENT server only (compose and CI).
# Never for the test server or production: those get a real OpenBao, set up separately.
#
# Needs: BAO_ADDR, BAO_TOKEN (the dev server's root token) and OPENBAO_API_TOKEN (the token the
# API will use). Safe to run again: each step checks first.
#
# The API's token can encrypt and decrypt with `shri-fields` (field encryption), and make and
# unwrap data keys with `shri-files` (file envelope encryption), both in core/crypto.py. It can't
# read or export either key, encrypt with `shri-files`, make data keys with `shri-fields`, use
# another key, or create tokens.
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

bao policy write "$POLICY" - >/dev/null <<EOF
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

echo "OpenBao Transit ready: keys $KEY and $FILES_KEY, the API's token limited to what it needs"
