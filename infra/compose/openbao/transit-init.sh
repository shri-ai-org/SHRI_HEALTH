#!/bin/sh
# Sets up OpenBao's Transit engine for the API, on the DEVELOPMENT server only (compose and CI).
# Never for the test server or production: those get a real OpenBao, set up separately.
#
# Needs: BAO_ADDR, BAO_TOKEN (the dev server's root token) and OPENBAO_API_TOKEN (the token the
# API will use). Safe to run again: each step checks first.
#
# The API's token can do exactly two things: encrypt and decrypt with the one key `shri-fields`
# (core/crypto.py). It can't read or export the key, use another key, or create tokens.
set -eu

: "${BAO_ADDR:?}" "${BAO_TOKEN:?}" "${OPENBAO_API_TOKEN:?}"
KEY=shri-fields
POLICY=shri-api-transit

if ! bao secrets list -format=json | grep -q '"transit/"'; then
    bao secrets enable transit >/dev/null
fi

if ! bao read "transit/keys/$KEY" >/dev/null 2>&1; then
    bao write -f "transit/keys/$KEY" type=aes256-gcm96 >/dev/null
fi

bao policy write "$POLICY" - >/dev/null <<EOF
path "transit/encrypt/$KEY" {
  capabilities = ["update"]
}
path "transit/decrypt/$KEY" {
  capabilities = ["update"]
}
EOF

# A fixed token ID from the environment, so the API can be given it without reading it back.
# No default policy (it can't even look itself up), not renewable, and it's not a child of root.
if ! bao token lookup "$OPENBAO_API_TOKEN" >/dev/null 2>&1; then
    bao token create -id="$OPENBAO_API_TOKEN" -policy="$POLICY" -no-default-policy -orphan \
        -renewable=false -ttl=768h >/dev/null
fi

echo "OpenBao Transit ready: key $KEY, the API's token limited to encrypt and decrypt with it"
