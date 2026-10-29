#!/bin/sh
# The demo accounts (D95, demo on 20 Nov): four staff users in shri-staff and one patient in
# shri-patients, each with a FIXED Keycloak user ID, so Anand's seed (#85) can link them to
# app_user, user_role and portal_account rows that never change. Synthetic people only.
#
#   KC_URL=https://localhost:8443/kc KC_ADMIN=admin KC_ADMIN_PASSWORD=... DEMO_PASSWORD=... \
#       sh infra/keycloak/reset-demo-users.sh
#
# Safe to run again: Keycloak's partial import with ifResourceExists=OVERWRITE puts each user back
# exactly as below (same ID, enabled, the password reset to DEMO_PASSWORD, the one-time code to
# set up again at the next sign-in). The password comes from the environment, never from this
# file; it must meet the realms' policy (at least 12 characters, not the username or email).
# The patient realm is skipped, with a note, until it exists (#148).
#
# Needs curl and sed only. The admin password and DEMO_PASSWORD are never printed.
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
FD_ID=bfb3e893-5380-4260-b1b9-420ee3a9e6e4
MA_ID=8474b553-c2bb-4a7b-a098-cc4bfdf5f4ac
MD_ID=490ef6d1-2e36-40ed-88eb-132538695ad9
ADM_ID=9a805285-df36-4ce9-abcc-3844ab784dfa
PATIENT_ID=8e477695-3ea5-4082-8765-2b8edee9123c

CURL="curl -sS --fail-with-body"
[ "${KC_INSECURE:-}" = 1 ] && CURL="$CURL -k"  # the local self-signed certificate only

token=$($CURL -d grant_type=password -d client_id=admin-cli --data-urlencode "username=$KC_ADMIN" \
    --data-urlencode "password=$KC_ADMIN_PASSWORD" "$KC_URL/realms/master/protocol/openid-connect/token" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo "Could not sign in to Keycloak's admin API" >&2; exit 1; }

# user ID username email first last
user() {
    printf '{"id":"%s","username":"%s","email":"%s","emailVerified":true,"enabled":true,' "$1" "$2" "$3"
    printf '"firstName":"%s","lastName":"%s","requiredActions":["CONFIGURE_TOTP"],' "$4" "$5"
    printf '"credentials":[{"type":"password","value":"%s","temporary":false}]}' "$DEMO_PASSWORD"
}

import() {  # realm users-json
    body=$(printf '{"ifResourceExists":"OVERWRITE","users":[%s]}' "$2")
    $CURL -o /dev/null -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
        --data-binary @- "$KC_URL/admin/realms/$1/partialImport" <<EOF
$body
EOF
}

import shri-staff "$(user "$FD_ID" demo.frontdesk demo.frontdesk@example.com Dana Frontdesk),\
$(user "$MA_ID" demo.ma demo.ma@example.com Max Assistant),\
$(user "$MD_ID" demo.doctor demo.doctor@example.com Rivera Doctor),\
$(user "$ADM_ID" demo.admin demo.admin@example.com Alex Admin)"
echo "shri-staff: demo.frontdesk ($FD_ID), demo.ma ($MA_ID), demo.doctor ($MD_ID), demo.admin ($ADM_ID)"

if $CURL -o /dev/null -H "Authorization: Bearer $token" "$KC_URL/admin/realms/shri-patients" 2>/dev/null; then
    # The patient signs in with the email as username (the realm's rule).
    import shri-patients "$(user "$PATIENT_ID" demo.patient@example.com demo.patient@example.com Mai Nguyen)"
    echo "shri-patients: demo.patient@example.com ($PATIENT_ID)"
else
    echo "shri-patients: the realm doesn't exist yet (#148); skipped"
fi
