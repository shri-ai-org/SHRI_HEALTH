#!/bin/sh
# The demo accounts (D95, demo on 20 Nov): four staff users in shri-staff and one patient in
# shri-patients, each with a FIXED Keycloak user ID, so Anand's seed (#85) can link them to
# app_user, user_role and portal_account rows that never change. Synthetic people only.
#
#   KC_URL=https://localhost:8443/kc KC_ADMIN=admin KC_ADMIN_PASSWORD=... DEMO_PASSWORD=... \
#       sh infra/keycloak/reset-demo-users.sh
#
# Safe to run again, and run by every demo `up` and `reset`: a missing user is created as below
# (fixed ID, the password DEMO_PASSWORD, the one-time code to set up at the first sign-in); an
# existing one keeps its password and its authenticator, so presenters don't enrol again between
# rehearsals, and is enabled again (the demo disables one in the console, D101). Multi-factor
# stays required either way. DEMO_USERS_RECREATE=1 puts every user back exactly as below
# instead (the password reset, the authenticator removed): for a lost phone or password.
# The password comes from the environment, never from this file; it must meet the realms' policy
# (at least 12 characters, not the username or email).
# The patient realm is skipped, with a note, until it exists (#148).
#
# DEMO_SKIP_AUTH_CODE=1 (deploy.sh, SHRI_DEMO_SKIP_AUTH_CODE, demo servers only): sign-in is the
# username and password alone. The one-time code step of both realms' browser flows is set to
# DISABLED and the demo users are asked for no authenticator. Without it, the step is set back
# to REQUIRED, so taking the setting out restores multi-factor at the next up or reset. The realm
# files (and so every other environment) always require the code.
#
# Needs curl and sed only. No secret is ever printed or put on a command line (where `ps` would
# show it): the admin password and the admin token reach curl through stdin or a private
# temporary file (mode 600, removed on exit), and DEMO_PASSWORD through the request body.
set -eu

: "${KC_URL:?set KC_URL, e.g. https://localhost:8443/kc}"
: "${KC_ADMIN:?set KC_ADMIN}" "${KC_ADMIN_PASSWORD:?set KC_ADMIN_PASSWORD}"
: "${DEMO_PASSWORD:?set DEMO_PASSWORD (at least 12 characters)}"
if [ "${#DEMO_PASSWORD}" -lt 12 ]; then
    echo "DEMO_PASSWORD must be at least 12 characters (the realms' password policy)" >&2
    exit 1
fi
case "$DEMO_PASSWORD" in *'"'*|*'\'*)
    echo "DEMO_PASSWORD may not contain a double quote or a backslash" >&2; exit 1 ;;
esac

# Fixed IDs: never change them, the seed and the demo script refer to them (#85).
# Names (D112): these display names are the source of truth, which the database seed reads, and
# every one is obviously fictional (Synthea-style, with digits) so no demo person resembles a real
# one. The doctor matches the seed's practitioner and the patient the seed's patient 1.
FD_ID=bfb3e893-5380-4260-b1b9-420ee3a9e6e4
MA_ID=8474b553-c2bb-4a7b-a098-cc4bfdf5f4ac
MD_ID=490ef6d1-2e36-40ed-88eb-132538695ad9
ADM_ID=9a805285-df36-4ce9-abcc-3844ab784dfa
PATIENT_ID=8e477695-3ea5-4082-8765-2b8edee9123c

CURL="curl -sS --fail-with-body"
[ "${KC_INSECURE:-}" = 1 ] && CURL="$CURL -k"  # the local self-signed certificate only

# A value inside a double-quoted curl config string: backslash and quote escaped.
quoted() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

token=$(printf 'data-urlencode = "password=%s"\n' "$(quoted "$KC_ADMIN_PASSWORD")" \
    | $CURL -K - -d grant_type=password -d client_id=admin-cli --data-urlencode "username=$KC_ADMIN" \
        "$KC_URL/realms/master/protocol/openid-connect/token" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo "Could not sign in to Keycloak's admin API" >&2; exit 1; }

# The token for the calls below, in a file only this user can read, removed however we exit.
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT INT TERM
chmod 600 "$auth"
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$auth"
unset token

if [ "${DEMO_SKIP_AUTH_CODE:-}" = 1 ]; then ACTIONS='' CODE=DISABLED; else ACTIONS='"CONFIGURE_TOTP"' CODE=REQUIRED; fi

# realm flow-alias: the browser flow's one-time code step, REQUIRED or DISABLED as above.
code_step() {
    flow=$(printf '%s' "$2" | sed 's/ /%20/g')
    id=$($CURL -K "$auth" "$KC_URL/admin/realms/$1/authentication/flows/$flow/executions" \
        | sed 's/},{/}\n{/g' | grep '"providerId":"auth-otp-form"' \
        | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$id" ] || { echo "$1: no one-time code step in '$2'" >&2; exit 1; }
    $CURL -o /dev/null -K "$auth" -X PUT -H "Content-Type: application/json" \
        -d "{\"id\":\"$id\",\"requirement\":\"$CODE\"}" \
        "$KC_URL/admin/realms/$1/authentication/flows/$flow/executions"
    echo "$1: the one-time code is $CODE"
}

# user ID username email first last
user() {
    printf '{"id":"%s","username":"%s","email":"%s","emailVerified":true,"enabled":true,' "$1" "$2" "$3"
    printf '"firstName":"%s","lastName":"%s","requiredActions":[%s],' "$4" "$5" "$ACTIONS"
    printf '"credentials":[{"type":"password","value":"%s","temporary":false}]}' "$DEMO_PASSWORD"
}

import() {  # realm users-json
    existing=SKIP
    [ "${DEMO_USERS_RECREATE:-}" = 1 ] && existing=OVERWRITE
    body=$(printf '{"ifResourceExists":"%s","users":[%s]}' "$existing" "$2")
    $CURL -o /dev/null -K "$auth" -H "Content-Type: application/json" \
        --data-binary @- "$KC_URL/admin/realms/$1/partialImport" <<EOF
$body
EOF
}

enable() {  # realm user-id...: a skipped user may have been disabled in the console (D101)
    realm=$1; shift
    # Skipping the code also clears a pending authenticator setup; otherwise a user's required
    # actions stay as they are (one who set up the authenticator isn't asked again).
    body='{"enabled":true}'
    [ "${DEMO_SKIP_AUTH_CODE:-}" = 1 ] && body='{"enabled":true,"requiredActions":[]}'
    for id in "$@"; do
        $CURL -o /dev/null -K "$auth" -X PUT -H "Content-Type: application/json" \
            -d "$body" "$KC_URL/admin/realms/$realm/users/$id"
    done
}

import shri-staff "$(user "$FD_ID" demo.frontdesk demo.frontdesk@example.com Marlo512 Ferreira77),\
$(user "$MA_ID" demo.ma demo.ma@example.com Tobias289 Lindqvist45),\
$(user "$MD_ID" demo.doctor demo.doctor@example.com Rowan318 Halvorsen64),\
$(user "$ADM_ID" demo.admin demo.admin@example.com Sasha627 Brennan52)"
enable shri-staff "$FD_ID" "$MA_ID" "$MD_ID" "$ADM_ID"
code_step shri-staff "shri browser forms"
echo "shri-staff: demo.frontdesk ($FD_ID), demo.ma ($MA_ID), demo.doctor ($MD_ID), demo.admin ($ADM_ID)"

if $CURL -o /dev/null -K "$auth" "$KC_URL/admin/realms/shri-patients" 2>/dev/null; then
    # The patient signs in with the email as username (the realm's rule).
    import shri-patients "$(user "$PATIENT_ID" demo.patient@example.com demo.patient@example.com Kaia401 Lindgren118)"
    enable shri-patients "$PATIENT_ID"
    code_step shri-patients "shri patient browser forms"
    echo "shri-patients: demo.patient@example.com ($PATIENT_ID)"
else
    echo "shri-patients: the realm doesn't exist yet (#148); skipped"
fi
