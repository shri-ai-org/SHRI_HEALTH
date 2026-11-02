#!/bin/sh
# Runs inside the openbao container (deploy.sh pipes it in): initialises OpenBao on its first start,
# unseals it, and sets up Transit for the API (infra/compose/openbao/transit-init.sh).
#
# On the first start it prints one line, `INIT <unseal key> <root token>`, which deploy.sh stores
# in the state directory (mode 600, outside the repository) and never shows. After that it reads
# them from BAO_UNSEAL_KEY and BAO_ROOT_TOKEN. One key share: a single test host with synthetic
# data only; production gets a managed unseal (Q25, AWS KMS) and no root token at rest.
set -eu
export BAO_ADDR=http://127.0.0.1:8200

state=$(bao status -format=json 2>/dev/null || true)
case "$state" in
    *'"initialized": false'*)
        out=$(bao operator init -key-shares=1 -key-threshold=1)
        BAO_UNSEAL_KEY=$(printf '%s\n' "$out" | sed -n 's/^Unseal Key 1: *//p' | head -1)
        BAO_ROOT_TOKEN=$(printf '%s\n' "$out" | sed -n 's/^Initial Root Token: *//p' | head -1)
        [ -n "$BAO_UNSEAL_KEY" ] && [ -n "$BAO_ROOT_TOKEN" ] || { echo "init output not understood" >&2; exit 1; }
        echo "INIT $BAO_UNSEAL_KEY $BAO_ROOT_TOKEN"
        exit 0  # deploy.sh stores them first, then runs this again to unseal
        ;;
esac

: "${BAO_UNSEAL_KEY:?the unseal key (deploy.sh passes it from the state directory)}"
: "${BAO_ROOT_TOKEN:?the root token (deploy.sh passes it from the state directory)}"
if bao status >/dev/null 2>&1; then :; else
    # Through the API with the key in a private file: `bao operator unseal` takes it only as an
    # argument (visible to ps) or from a terminal.
    body=$(umask 077; mktemp)
    printf '{"key":"%s"}' "$BAO_UNSEAL_KEY" >"$body"
    wget -q -O /dev/null --post-file="$body" "$BAO_ADDR/v1/sys/unseal" || { rm -f "$body"; exit 1; }
    rm -f "$body"
fi

# The API's narrow Transit token (32 days, not renewable) is created again here once it expires.
BAO_TOKEN="$BAO_ROOT_TOKEN" sh /init/transit-init.sh >&2
