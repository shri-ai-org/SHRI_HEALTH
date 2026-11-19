#!/usr/bin/env bash
# The manual deploy for one Linux host with Docker (infra/deploy/README.md). Synthetic data only.
#
#   infra/deploy/deploy.sh init-env /etc/shri/deploy.env   # once: a new settings file, random secrets
#   infra/deploy/deploy.sh up       /etc/shri/deploy.env   # build, start, migrate, demo reset, check
#   infra/deploy/deploy.sh check    /etc/shri/deploy.env   # the health check only
#   infra/deploy/deploy.sh reset    /etc/shri/deploy.env   # demo only: erase the database, back to the demo data
#   infra/deploy/deploy.sh down     /etc/shri/deploy.env   # stop (volumes, and so the data, stay)
#   infra/deploy/deploy.sh host-nginx /etc/shri/deploy.env # behind a shared host's Nginx: its site file
#
# The settings file holds every secret: it must be mode 600 and outside the repository. Secrets
# never go on a command line (where `ps` shows them) and are never printed: they reach compose
# through --env-file, OpenBao and the seed through stdin or the container environment.
# `up` deploys the commit that is checked out; the images are built from it and tagged with it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$REPO/infra/deploy"
# The compose project (SHRI_PROJECT, default shri-deploy): every container, network and volume
# deploy.sh touches carries it, so on a shared host nothing else is ever stopped or changed.
PROJECT=shri-deploy

die() { echo "deploy: $*" >&2; exit 1; }
say() { echo "== $*"; }

compose_cmd() {
    if docker compose version >/dev/null 2>&1; then echo "docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"
    else die "Docker Compose v2 or later is needed (README: host setup)"; fi
}

secret() { openssl rand -hex "${1:-32}"; }

# Mailpit's web UI credential (demo hosts): user demo-admin, a random password in
# DIR/mailpit/ui-password and its htpasswd line (apr1, read by Mailpit and by the host's Nginx) in
# DIR/mailpit/ui.htpasswd, both mode 600. Kept when they exist. The password never reaches a
# command line (openssl reads it on stdin) and is never printed.
mailpit_credential() {
    local dir="$1/mailpit" password
    [ -s "$dir/ui-password" ] && [ -s "$dir/ui.htpasswd" ] && return 0
    (
        umask 077
        mkdir -p "$dir"
        password="$(secret 24)"
        printf '%s\n' "$password" >"$dir/ui-password"
        printf 'demo-admin:%s\n' "$(printf '%s\n' "$password" | openssl passwd -apr1 -stdin)" >"$dir/ui.htpasswd"
    )
    chmod 700 "$dir"
    chmod 600 "$dir/ui-password" "$dir/ui.htpasswd"
    grep -q '^demo-admin:\$apr1\$' "$dir/ui.htpasswd" || die "could not write Mailpit's credential in $dir"
}

# The worker's email (integration/mail.py), demo hosts only: SHRI_EMAIL_TEAM_ALLOWLIST (the team's
# own addresses, comma-separated) go out through Brevo, from SHRI_EMAIL_FROM_ADDRESS; everyone else
# to Mailpit. Elsewhere all three are empty, so the worker sends no email. Brevo's key is never in
# the settings file: it is BREVO_API_KEY in OpenBao (README, set-secret.sh).
email_settings() {
    local address='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'
    SHRI_WORKER_EMAIL_TEAM_ALLOWLIST="" SHRI_WORKER_EMAIL_FROM_ADDRESS="" SHRI_WORKER_MAILPIT_SMTP_HOST=""
    if [ "${SHRI_DEMO:-false}" = true ]; then
        SHRI_WORKER_MAILPIT_SMTP_HOST=mailpit
        if [ -n "${SHRI_EMAIL_TEAM_ALLOWLIST:-}" ]; then
            [[ "$SHRI_EMAIL_TEAM_ALLOWLIST" =~ ^$address(,$address)*$ ]] \
                || die "SHRI_EMAIL_TEAM_ALLOWLIST is email addresses separated by commas (no spaces)"
            [[ "${SHRI_EMAIL_FROM_ADDRESS:-}" =~ ^$address$ ]] \
                || die "SHRI_EMAIL_TEAM_ALLOWLIST needs SHRI_EMAIL_FROM_ADDRESS (a sender Brevo has verified)"
            SHRI_WORKER_EMAIL_TEAM_ALLOWLIST="$SHRI_EMAIL_TEAM_ALLOWLIST"
            SHRI_WORKER_EMAIL_FROM_ADDRESS="$SHRI_EMAIL_FROM_ADDRESS"
        fi
    elif [ -n "${SHRI_EMAIL_TEAM_ALLOWLIST:-}" ]; then
        die "SHRI_EMAIL_TEAM_ALLOWLIST needs SHRI_DEMO=true (Brevo signs no BAA; never with real patients)"
    fi
    export SHRI_WORKER_EMAIL_TEAM_ALLOWLIST SHRI_WORKER_EMAIL_FROM_ADDRESS SHRI_WORKER_MAILPIT_SMTP_HOST
}

init_env() {
    local file="$1"
    [ -e "$file" ] && die "$file exists; edit it instead"
    case "$(cd "$(dirname "$file")" && pwd)/" in "$REPO"/*) die "keep the settings file outside the repository";; esac
    umask 077
    cat >"$file" <<EOF
# Shri Health test-server settings (infra/deploy/README.md). Mode 600; never commit or share it.
# The host as browsers reach it, and its public HTTPS port.
SHRI_HOSTNAME=shri.localhost
SHRI_HTTPS_PORT=443
# Behind a shared host's own Nginx (README "Two ways to serve it"), set the one public address
# instead, a host of its own or a path: https://dep.shri-ai.org or https://shri-ai.org/dep.
# Then SHRI_HOSTNAME comes from it, SHRI_HTTPS_PORT is our local port on 127.0.0.1 (e.g. 9443),
# and every port is bound to 127.0.0.1. Leave it empty on a host of our own.
SHRI_SITE_URL=
# A unique compose project name, and two free /24s for its networks (first three numbers).
SHRI_PROJECT=shri-deploy
SHRI_NET_A=172.31.250
SHRI_NET_B=172.31.251
# staging for the test server. production is refused with SHRI_DEMO=true.
SHRI_ENVIRONMENT=staging
# true: the simulated payer and pharmacy, the demo accounts and the demo data (D95).
SHRI_DEMO=false
# true: real patient sign-in (the patient realm) on this server. Only with SHRI_DEMO=true, so only
# fictional patients, until the pilot gates are done (Q33's bot check and the shared rate limiter).
SHRI_PATIENT_SIGN_IN=false
# true: demo sign-in is the username and password alone, no authenticator code (both realms, on
# this server only). Only with SHRI_DEMO=true; every other environment requires the code (D85).
SHRI_DEMO_SKIP_AUTH_CODE=false
# true: the screens are built with the AI features shown (Draft with AI, chart summary, assistant,
# morning brief, differentials; the VITE_FEATURE_AI_* flags, read at build time). Only with
# SHRI_DEMO=true. Each feature still needs its per-clinic switch and the Claude key (D116, D12).
SHRI_DEMO_AI_SCREENS=false
# true: the patient portal's demo sign-in, mobile number + date of birth with no code or password
# (D121; patients without a portal account). Only with SHRI_DEMO=true; the API refuses it otherwise.
SHRI_DEMO_SIGN_IN=false
# The worker's email (demo hosts only): these team addresses (comma-separated, no spaces) get real
# mail through Brevo, from SHRI_EMAIL_FROM_ADDRESS (a sender Brevo has verified); every other
# address goes to Mailpit. Empty: all mail goes to Mailpit. Brevo's key is BREVO_API_KEY in OpenBao
# (README), never here.
SHRI_EMAIL_TEAM_ALLOWLIST=
SHRI_EMAIL_FROM_ADDRESS=
# Leave empty: the demo patients are then booked on the day the seed runs, in the clinic's time
# zone (San Jose), so every rehearsal has a full day, and the reset on 20 Nov after 13:30 IST gives
# the demo day. A date (YYYY-MM-DD, seed/demo.py) only to rehearse a particular day; never left
# set, or later rehearsals get an empty list. Only with SHRI_DEMO=true; passed to the seed only
# when set.
SHRI_DEMO_DAY=
# self-signed (a local hostname) or provided (TLS_CERT_FILE and TLS_KEY_FILE, the real certificate).
TLS_MODE=self-signed
TLS_CERT_FILE=
TLS_KEY_FILE=
# Where deploy.sh keeps OpenBao's unseal key and root token and the self-signed certificate.
SHRI_STATE_DIR=$(cd "$(dirname "$file")" && pwd)/shri-state
# Keycloak's admin console, on this host's loopback only (reach it over an SSH tunnel).
SHRI_KC_ADMIN_PORT=8081
# Mailpit's web UI (demo hosts only: the mail Keycloak sends), on this host's loopback only.
# Its demo-admin password is in SHRI_STATE_DIR/mailpit/ui-password, never in this file.
SHRI_MAILPIT_UI_PORT=8025

POSTGRES_DB=shri_health
POSTGRES_USER=shri
POSTGRES_PASSWORD=$(secret)
SHRI_MIGRATOR_PASSWORD=$(secret)
SHRI_APP_PASSWORD=$(secret)
SHRI_FHIR_READER_PASSWORD=$(secret)
SHRI_INTEGRATION_PASSWORD=$(secret)
SHRI_REPORTING_PASSWORD=$(secret)
SHRI_MAINTENANCE_PASSWORD=$(secret)
SHRI_PORTAL_PASSWORD=$(secret)
SHRI_PUBLIC_PASSWORD=$(secret)
KEYCLOAK_DB_PASSWORD=$(secret)
# Not used by the deploy overlay (OpenBao runs as a real server); the base compose file asks for it.
OPENBAO_DEV_ROOT_TOKEN=$(secret)
OPENBAO_API_TOKEN=$(secret)
PUBLIC_FORM_SECRET=$(secret)
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=$(secret)
SHRI_WEB_CLIENT_SECRET=$(secret)
SESSION_SECRET=$(secret)
SHRI_PORTAL_CLIENT_SECRET=$(secret)
SHRI_PORTAL_ADMIN_CLIENT_SECRET=$(secret)
PORTAL_SESSION_SECRET=$(secret)
PORTAL_INVITATION_SECRET=$(secret)
FILE_STORE_SECRET_ACCESS_KEY=$(secret)
HOOK_SECRET_CLEARINGHOUSE=$(secret)
HOOK_SECRET_ERX=$(secret)
# The demo accounts' password (reset-demo-users.sh); at least 12 characters.
DEMO_PASSWORD=$(secret 12)
EOF
    chmod 600 "$file"
    # Into the default state dir; `up` writes one there too if SHRI_STATE_DIR is moved.
    local state
    state="$(cd "$(dirname "$file")" && pwd)/shri-state"
    (umask 077; mkdir -p "$state")
    mailpit_credential "$state"
    echo "Wrote $file (mode 600). Set SHRI_HOSTNAME, SHRI_HTTPS_PORT, SHRI_DEMO and TLS_* there."
    echo "Mailpit's demo-admin password (demo hosts): $state/mailpit/ui-password (mode 600)."
}

load_env() {
    ENV_FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    [ -f "$ENV_FILE" ] || die "no settings file at $1 (run: deploy.sh init-env $1)"
    case "$ENV_FILE" in "$REPO"/*) die "the settings file must be outside the repository";; esac
    [ "$(stat -c %a "$ENV_FILE")" = 600 ] || die "$ENV_FILE must be mode 600 (chmod 600 $ENV_FILE)"
    [ "$(stat -c %u "$ENV_FILE")" = "$(id -u)" ] || die "$ENV_FILE must belong to the user running deploy.sh"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    : "${SHRI_HOSTNAME:?}" "${SHRI_STATE_DIR:?}"
    case "$SHRI_HOSTNAME" in *[!A-Za-z0-9.-]*) die "SHRI_HOSTNAME is not a hostname";; esac
    case "${SHRI_ENVIRONMENT:-staging}" in staging|production) ;; *) die "SHRI_ENVIRONMENT is staging or production";; esac
    case "${SHRI_DEMO:-false}" in true|false) ;; *) die "SHRI_DEMO is true or false";; esac
    if [ "${SHRI_ENVIRONMENT:-staging}" = production ] && [ "${SHRI_DEMO:-false}" = true ]; then
        die "the demo (simulated partners, synthetic seed, the Mailpit mail catcher) is never deployed to production"
    fi
    # Patient sign-in: the API gets the patient realm's client secrets only when it is on;
    # without them its sign-in and enrolment routes answer 503. Keycloak always has them.
    case "${SHRI_PATIENT_SIGN_IN:-false}" in
        true) [ "${SHRI_DEMO:-false}" = true ] \
                  || die "SHRI_PATIENT_SIGN_IN=true needs SHRI_DEMO=true (fictional patients only, until the pilot gates)"
              : "${SHRI_PORTAL_CLIENT_SECRET:?}" "${SHRI_PORTAL_ADMIN_CLIENT_SECRET:?}"
              export SHRI_API_PORTAL_CLIENT_SECRET="$SHRI_PORTAL_CLIENT_SECRET"
              export SHRI_API_PORTAL_ADMIN_CLIENT_SECRET="$SHRI_PORTAL_ADMIN_CLIENT_SECRET" ;;
        false) export SHRI_API_PORTAL_CLIENT_SECRET="" SHRI_API_PORTAL_ADMIN_CLIENT_SECRET="" ;;
        *) die "SHRI_PATIENT_SIGN_IN is true or false" ;;
    esac
    case "${SHRI_DEMO_SKIP_AUTH_CODE:-false}" in
        true) [ "${SHRI_DEMO:-false}" = true ] \
                  || die "SHRI_DEMO_SKIP_AUTH_CODE=true needs SHRI_DEMO=true (fictional data only; D85 elsewhere)"
              DEMO_SKIP_AUTH_CODE=1 ;;
        false) DEMO_SKIP_AUTH_CODE= ;;
        *) die "SHRI_DEMO_SKIP_AUTH_CODE is true or false" ;;
    esac
    case "${SHRI_DEMO_AI_SCREENS:-false}" in
        true) [ "${SHRI_DEMO:-false}" = true ] \
                  || die "SHRI_DEMO_AI_SCREENS=true needs SHRI_DEMO=true (fictional data only until a BAA, D12)"
              export SHRI_WEB_AI=on ;;
        false) export SHRI_WEB_AI=off ;;
        *) die "SHRI_DEMO_AI_SCREENS is true or false" ;;
    esac
    # D121: the portal's demo sign-in (mobile number + date of birth), synthetic patients only.
    # The API refuses it too unless SHRI_DEMO=true outside production.
    case "${SHRI_DEMO_SIGN_IN:-false}" in
        true) [ "${SHRI_DEMO:-false}" = true ] \
                  || die "SHRI_DEMO_SIGN_IN=true needs SHRI_DEMO=true (D121: demo servers only, synthetic patients)"
              export SHRI_API_DEMO_SIGN_IN=true SHRI_WEB_DEMO_SIGN_IN=on ;;
        false) export SHRI_API_DEMO_SIGN_IN=false SHRI_WEB_DEMO_SIGN_IN=off ;;
        *) die "SHRI_DEMO_SIGN_IN is true or false" ;;
    esac
    # Mailpit, the demo mail catcher (its compose profile, switched on here only), and the screens'
    # password help that relies on it: demo hosts only, never production. The profile is
    # deploy.sh's alone, so a settings file or shell can't switch it on behind these checks.
    [ -z "${COMPOSE_PROFILES:-}" ] \
        || die "COMPOSE_PROFILES is set by deploy.sh (Mailpit only with SHRI_DEMO=true): remove it from $ENV_FILE and the shell"
    if [ "${SHRI_DEMO:-false}" = true ]; then
        [ "${SHRI_ENVIRONMENT:-staging}" != production ] \
            || die "Mailpit (the demo mail catcher) never runs in production: SHRI_ENVIRONMENT=production needs SHRI_DEMO=false"
        export COMPOSE_PROFILES=mailpit SHRI_WEB_PASSWORD_HELP=on
    else
        unset COMPOSE_PROFILES
        export SHRI_WEB_PASSWORD_HELP=off
    fi
    SHRI_MAILPIT_UI_PORT="${SHRI_MAILPIT_UI_PORT:-8025}"
    [[ "$SHRI_MAILPIT_UI_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || die "SHRI_MAILPIT_UI_PORT is a port number"
    SHRI_DEMO_DAY="${SHRI_DEMO_DAY:-}"
    if [ -n "$SHRI_DEMO_DAY" ]; then
        [ "${SHRI_DEMO:-false}" = true ] || die "SHRI_DEMO_DAY needs SHRI_DEMO=true (it moves the demo data)"
        [[ "$SHRI_DEMO_DAY" =~ ^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$ ]] \
            || die "SHRI_DEMO_DAY is a date, YYYY-MM-DD, or empty for the day the seed runs"
        DEMO_DAY_ARGS=(-e "SHRI_DEMO_DAY=$SHRI_DEMO_DAY")
    else
        DEMO_DAY_ARGS=()   # unset: the seed's own default, the day it runs
    fi
    PROJECT="${SHRI_PROJECT:-shri-deploy}"
    [[ "$PROJECT" =~ ^shri-[a-z0-9-]+$ ]] || die "SHRI_PROJECT must start with shri- (lower case, digits, -)"
    SHRI_NET_A="${SHRI_NET_A:-172.31.250}" SHRI_NET_B="${SHRI_NET_B:-172.31.251}"
    for net in "$SHRI_NET_A" "$SHRI_NET_B"; do
        [[ "$net" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || die "SHRI_NET_A and SHRI_NET_B are the first three numbers of a /24"
    done
    [ "$SHRI_NET_A" != "$SHRI_NET_B" ] || die "SHRI_NET_A and SHRI_NET_B must differ"
    SHRI_HTTPS_PORT="${SHRI_HTTPS_PORT:-443}"
    if [ -n "${SHRI_SITE_URL:-}" ]; then
        # Behind a shared host's Nginx: one public address decides the mode.
        [[ "$SHRI_SITE_URL" =~ ^https://([a-z0-9.-]+)(:([0-9]+))?(/[a-z0-9-]+)?$ ]] \
            || die "SHRI_SITE_URL is https://host or https://host/path (lower case, no trailing /)"
        SHRI_HOSTNAME="${BASH_REMATCH[1]}" SHRI_PUBLIC_PORT="${BASH_REMATCH[3]:-443}"
        SHRI_BASE_PATH="${BASH_REMATCH[4]}"
        SHRI_PUBLIC_URL="$SHRI_SITE_URL" SHRI_BIND=127.0.0.1
        [ "${TLS_MODE:-self-signed}" = self-signed ] \
            || die "behind a host's Nginx the real certificate is the host's: TLS_MODE=self-signed (our local hop)"
        [ "$SHRI_HTTPS_PORT" != "$SHRI_PUBLIC_PORT" ] || die "SHRI_HTTPS_PORT is our local port, not the public $SHRI_PUBLIC_PORT"
        # Not includeSubDomains: the host's other names (the company's) aren't ours to pin.
        SHRI_HSTS="max-age=31536000"
        # The client address comes from the host's Nginx (it reaches us through the Docker gateway).
        SHRI_REAL_IP="set_real_ip_from $SHRI_NET_A.1; real_ip_header X-Forwarded-For; real_ip_recursive off;"
    else
        SHRI_PUBLIC_PORT="$SHRI_HTTPS_PORT" SHRI_BASE_PATH="" SHRI_BIND=0.0.0.0
        SHRI_HSTS="max-age=31536000; includeSubDomains" SHRI_REAL_IP=""
        if [ "$SHRI_HTTPS_PORT" = 443 ]; then SHRI_PUBLIC_URL="https://$SHRI_HOSTNAME"
        else SHRI_PUBLIC_URL="https://$SHRI_HOSTNAME:$SHRI_HTTPS_PORT"; fi
    fi
    SHRI_COOKIE_PATH="${SHRI_BASE_PATH:-/}"
    # Our edge as this host reaches it (127.0.0.1), with the paths it serves (no base path).
    EDGE_URL="https://$SHRI_HOSTNAME:$SHRI_HTTPS_PORT"
    SHRI_RELEASE="$(git -C "$REPO" rev-parse --short=12 HEAD)"
    # The screens' build stamp (front office and doctors' portal): the image has no git, so the
    # commit and the day's version (that day's commits up to this one, India time, as the apps
    # count them) come from this checkout.
    export SHRI_BUILD_COMMIT="$SHRI_RELEASE"
    SHRI_BUILD_DAY_VERSION="$(git -C "$REPO" rev-list --count \
        --since="$(TZ=Asia/Kolkata date +%Y-%m-%d)T00:00:00+05:30" HEAD 2>/dev/null || echo 0)"
    export SHRI_BUILD_DAY_VERSION
    SHRI_BUILD_VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$REPO/backend/pyproject.toml" | head -1)"
    mkdir -p "$SHRI_STATE_DIR" && chmod 700 "$SHRI_STATE_DIR"
    # Mailpit's UI: under the public base path (so its links work behind a shared host's path) and
    # behind the demo-admin password, made here if this state dir has none yet (a demo host only).
    SHRI_MAILPIT_WEBROOT="$SHRI_BASE_PATH/mail/"
    SHRI_MAILPIT_AUTH_FILE="$SHRI_STATE_DIR/mailpit/ui.htpasswd"
    if [ "${SHRI_DEMO:-false}" = true ]; then mailpit_credential "$SHRI_STATE_DIR"; fi
    export SHRI_MAILPIT_UI_PORT SHRI_MAILPIT_WEBROOT SHRI_MAILPIT_AUTH_FILE
    # The partner worker's OpenBao token (read secret/shri-health/api only, for BREVO_API_KEY):
    # made once in the state dir (mode 600), never in the settings file or on a command line.
    if [ ! -s "$SHRI_STATE_DIR/openbao-worker-token" ]; then
        (umask 077; secret >"$SHRI_STATE_DIR/openbao-worker-token")
    fi
    chmod 600 "$SHRI_STATE_DIR/openbao-worker-token"
    SHRI_OPENBAO_WORKER_TOKEN="$(cat "$SHRI_STATE_DIR/openbao-worker-token")"
    export SHRI_OPENBAO_WORKER_TOKEN
    email_settings
    case "${TLS_MODE:-self-signed}" in
        self-signed)
            sh "$DEPLOY/tls/make-self-signed.sh" "$SHRI_HOSTNAME" "$SHRI_STATE_DIR/tls" >/dev/null
            TLS_CERT_FILE="$SHRI_STATE_DIR/tls/server.crt"; TLS_KEY_FILE="$SHRI_STATE_DIR/tls/server.key"
            CURL_TLS=(--cacert "$TLS_CERT_FILE") ;;
        provided)
            [ -r "${TLS_CERT_FILE:-}" ] && [ -r "${TLS_KEY_FILE:-}" ] || die "TLS_MODE=provided needs readable TLS_CERT_FILE and TLS_KEY_FILE"
            CURL_TLS=() ;;
        *) die "TLS_MODE is self-signed or provided" ;;
    esac
    export SHRI_HTTPS_PORT SHRI_PUBLIC_URL SHRI_RELEASE SHRI_BUILD_VERSION TLS_CERT_FILE TLS_KEY_FILE \
        SHRI_HOSTNAME SHRI_PUBLIC_PORT SHRI_BASE_PATH SHRI_BIND SHRI_HSTS SHRI_REAL_IP \
        SHRI_COOKIE_PATH SHRI_NET_A SHRI_NET_B
    DC="$(compose_cmd) --env-file $ENV_FILE -p $PROJECT -f $REPO/infra/compose/docker-compose.yml -f $DEPLOY/docker-compose.deploy.yml"
}

unseal() {
    local state="$SHRI_STATE_DIR/openbao.env" out
    for _ in $(seq 1 30); do
        $DC exec -T openbao sh -c 'bao status -address=http://127.0.0.1:8200 >/dev/null 2>&1; [ $? -ne 1 ]' && break
        sleep 1
    done
    # The key and token reach the script on stdin, never on a command line.
    out="$( {
        printf 'export OPENBAO_API_TOKEN=%s\n' "$OPENBAO_API_TOKEN"
        printf 'export OPENBAO_WORKER_TOKEN=%s\n' "$SHRI_OPENBAO_WORKER_TOKEN"
        if [ -f "$state" ]; then sed -n 's/^\(BAO_[A-Z_]*\)=\([A-Za-z0-9.+\/=_-]*\)$/export \1=\2/p' "$state"; fi
        cat "$DEPLOY/openbao/init-unseal.sh"
    } | $DC exec -T openbao sh -s)"
    if printf '%s\n' "$out" | grep -q '^INIT '; then
        [ -f "$state" ] && die "OpenBao was initialised again, but $state exists: investigate before going on"
        (umask 077; printf '%s\n' "$out" | sed -n 's/^INIT \([^ ]*\) \([^ ]*\)$/BAO_UNSEAL_KEY=\1\nBAO_ROOT_TOKEN=\2/p' >"$state")
        chmod 600 "$state"
        say "OpenBao initialised; its unseal key and root token are in $state (mode 600)"
        unseal  # now unseal with them and set up Transit
    fi
}

migrate() {
    # The extensions need the master user (as on RDS); then Alembic as shri_migrator only.
    $DC exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
        <"$REPO/backend/app/db/sql/00_extensions.sql"
    MIGRATION_DATABASE_URL="postgresql+psycopg://shri_migrator:${SHRI_MIGRATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
        $DC run --rm --no-deps -T -e MIGRATION_DATABASE_URL --entrypoint alembic api \
        -c app/db/alembic.ini upgrade head
}

demo_reset() {
    say "Demo accounts (Keycloak, fixed IDs)"
    KC_URL="http://127.0.0.1:${SHRI_KC_ADMIN_PORT:-8081}/kc" KC_ADMIN="$KEYCLOAK_ADMIN" \
        KC_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" DEMO_PASSWORD="$DEMO_PASSWORD" \
        DEMO_SKIP_AUTH_CODE="$DEMO_SKIP_AUTH_CODE" sh "$REPO/infra/keycloak/reset-demo-users.sh"
    say "Demo data (python -m app.db.seed demo, as shri_migrator; demo day: ${SHRI_DEMO_DAY:-the day it runs})"
    # The seed refuses staging unless SEED_ALLOW_STAGING=1 (its guard against real data, #159).
    # This host holds synthetic data only, and the demo never runs in production (checked above).
    MIGRATION_DATABASE_URL="postgresql+psycopg://shri_migrator:${SHRI_MIGRATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
        $DC run --rm --no-deps -T -e MIGRATION_DATABASE_URL -e SEED_ALLOW_STAGING=1 \
        "${DEMO_DAY_ARGS[@]}" --entrypoint python api -m app.db.seed demo
}

load_codes() {
    # Diagnosis and drug search need the code releases: Anand's loader fetches the pinned
    # ICD-10-CM and RxNorm releases (SHA-256-checked, public with no licence, D75) and loads them
    # as shri_migrator. The downloads are kept in a volume, so a host fetches each release once;
    # the API image runs as uid 10001, so the volume is handed to it first (the only root step).
    # It runs as the code-loader service: the API has no internet (egress/nginx.conf).
    say "Diagnosis and drug codes (python -m app.db.terminology all, as shri_migrator)"
    $DC run --rm --no-deps -T -u 0 -v "$PROJECT-terminology":/terminology --entrypoint chown code-loader 10001 /terminology
    MIGRATION_DATABASE_URL="postgresql+psycopg://shri_migrator:${SHRI_MIGRATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
        $DC run --rm --no-deps -T -e MIGRATION_DATABASE_URL -e SHRI_TERMINOLOGY_CACHE=/terminology \
        -v "$PROJECT-terminology":/terminology --entrypoint python code-loader -m app.db.terminology all
}

reset() {
    # The demo between rehearsal runs (plan §8): the application database is dropped and
    # created again, then filled with the demo data only. Keycloak's own database, OpenBao and
    # the files stay; only the demo accounts are put back. Never on a non-demo host.
    [ "${SHRI_DEMO:-false}" = true ] || die "reset erases the database: it runs only on a demo host (SHRI_DEMO=true)"
    : "${POSTGRES_DB:?}"
    # From the deployed commit only: the images are tagged by commit, so another checkout would
    # build and start a different API mid-reset.
    local running
    running="$(docker inspect --format '{{.Config.Image}}' "$($DC ps -q api)" 2>/dev/null || true)"
    [ "$running" = "shri-health/api:$SHRI_RELEASE" ] \
        || die "the host runs ${running:-no API}; reset from the checkout of the last 'up' (this is $SHRI_RELEASE)"
    say "Reset $SHRI_PUBLIC_URL: the database $POSTGRES_DB is erased and refilled with the demo data"
    # Typed, not a flag: a reset by mistake loses the rehearsal's state.
    if [ "${RESET_CONFIRM:-}" != "$SHRI_HOSTNAME" ]; then
        [ -t 0 ] || die "set RESET_CONFIRM=$SHRI_HOSTNAME to reset without a terminal"
        read -r -p "Type the hostname ($SHRI_HOSTNAME) to go on: " answer
        [ "$answer" = "$SHRI_HOSTNAME" ] || die "not reset"
    fi
    say "Stopping the API and the worker"
    $DC stop api integration-worker
    $DC up -d postgres
    for _ in $(seq 1 30); do $DC exec -T postgres pg_isready -q -h 127.0.0.1 && break; sleep 1; done
    say "Dropping and recreating $POSTGRES_DB (master user)"
    $DC exec -T -e DBNAME="$POSTGRES_DB" postgres sh -c \
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -v target="$DBNAME"' \
        <"$DEPLOY/postgres/recreate-database.sql"
    $DC exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
        <"$REPO/backend/app/db/sql/00_extensions.sql"
    say "Migrations and the demo data (python -m app.db.seed reset, as shri_migrator; demo day: ${SHRI_DEMO_DAY:-the day it runs})"
    # The reset refuses a database that has tables and, like the seed, staging without
    # SEED_ALLOW_STAGING=1 (#159); this host is a demo host (checked above).
    MIGRATION_DATABASE_URL="postgresql+psycopg://shri_migrator:${SHRI_MIGRATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
        $DC run --rm --no-deps -T -e MIGRATION_DATABASE_URL -e SEED_ALLOW_STAGING=1 \
        "${DEMO_DAY_ARGS[@]}" --entrypoint python api -m app.db.seed reset
    load_codes
    say "Demo accounts (Keycloak, fixed IDs)"
    KC_URL="http://127.0.0.1:${SHRI_KC_ADMIN_PORT:-8081}/kc" KC_ADMIN="$KEYCLOAK_ADMIN" \
        KC_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" DEMO_PASSWORD="$DEMO_PASSWORD" \
        DEMO_SKIP_AUTH_CODE="$DEMO_SKIP_AUTH_CODE" sh "$REPO/infra/keycloak/reset-demo-users.sh"
    say "Starting the API and the worker"
    $DC up -d api integration-worker
    # Nginx resolves the API's address only when it starts, and a restarted API can come back on
    # a new one (502 on every request): recreate it, as `up` does.
    $DC up -d --no-deps --force-recreate nginx
    check
}

wait_for() {  # url on our edge, what
    for _ in $(seq 1 90); do
        curl -fsS "${CURL_TLS[@]}" --resolve "$SHRI_HOSTNAME:$SHRI_HTTPS_PORT:127.0.0.1" -o /dev/null "$1" 2>/dev/null && return 0
        sleep 2
    done
    die "$2 did not answer at $1"
}

behind_host() { [ -n "${SHRI_SITE_URL:-}" ]; }

# Refuses to start if a port or a network we need belongs to something else on this host (a
# shared host runs other apps): never stops, moves or reuses what isn't this project's.
guard_ours() {
    local port net name subnets ports=("$SHRI_HTTPS_PORT" "${SHRI_KC_ADMIN_PORT:-8081}")
    [ "${SHRI_DEMO:-false}" = true ] && ports+=("$SHRI_MAILPIT_UI_PORT")
    for port in "${ports[@]}"; do
        if ss -Htln "sport = :$port" | grep -q .; then
            docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' \
                | grep -q ":$port->" || die "port $port is in use by something that isn't $PROJECT: choose another"
        fi
    done
    while read -r name subnets; do
        case "$name" in "${PROJECT}_"*) continue ;; esac
        for net in "$SHRI_NET_A" "$SHRI_NET_B"; do
            case " $subnets " in *" $net.0/24 "*)
                die "$net.0/24 is the Docker network $name's, not $PROJECT's: set SHRI_NET_A/B to free ones" ;; esac
        done
    done < <(docker network ls -q | xargs -r docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}')
}

sync_clients() {
    say "Keycloak sign-in addresses and login theme: $SHRI_PUBLIC_URL"
    wait_for "$EDGE_URL/kc/realms/shri-staff/.well-known/openid-configuration" "Keycloak"
    KC_URL="http://127.0.0.1:${SHRI_KC_ADMIN_PORT:-8081}/kc" KC_ADMIN="$KEYCLOAK_ADMIN" \
        KC_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" PUBLIC_URL="$SHRI_PUBLIC_URL" \
        SHRI_DEMO="${SHRI_DEMO:-false}" SHRI_HOSTNAME="$SHRI_HOSTNAME" \
        python3 -I "$REPO/infra/keycloak/sync-client-urls.py"
}

check() {
    # Our edge, as this host reaches it (127.0.0.1, the paths without the base path), and what it
    # must say about the public address. Behind a host's Nginx, the public address is checked
    # too once that host's site is in place.
    local curl=(curl -fsS "${CURL_TLS[@]}" --resolve "$SHRI_HOSTNAME:$SHRI_HTTPS_PORT:127.0.0.1")
    local E="$EDGE_URL" P="$SHRI_PUBLIC_URL" B="$SHRI_BASE_PATH"
    say "Health check: our edge $E, public address $P"
    wait_for "$E/health" "the API"
    [ "$("${curl[@]}" "$E/health")" = '{"status":"ok"}' ] || die "/health is not ok"
    $DC exec -T api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=5)" \
        || die "/ready failed (database, OpenBao or the operations map)"
    wait_for "$E/kc/realms/shri-staff/.well-known/openid-configuration" "Keycloak"
    for realm in shri-staff shri-patients; do
        "${curl[@]}" "$E/kc/realms/$realm/.well-known/openid-configuration" \
            | grep -q "\"issuer\":\"$P/kc/realms/$realm\"" || die "$realm's issuer is not $P"
    done
    # Sign-in: starts at Keycloak's public address, comes back to ours, and Keycloak shows its
    # sign-in page for it (so the client's redirect URI is the public one); the login cookie
    # carries this mode's name and path (core/cookies.py).
    local headers location cookie
    headers="$("${curl[@]}" -o /dev/null -D - "$E/api/v1/auth/login")"
    location="$(printf '%s' "$headers" | tr -d '\r' | sed -n 's/^[Ll]ocation: *//p')"
    case "$location" in "$P/kc/realms/shri-staff/protocol/openid-connect/auth?"*) ;;
        *) die "staff sign-in does not start at $P/kc" ;; esac
    case "$location" in *"redirect_uri=$(printf '%s' "$P/api/v1/auth/callback" | sed 's/:/%3A/g; s|/|%2F|g')"*) ;;
        *) die "staff sign-in does not come back to $P/api/v1/auth/callback" ;; esac
    if [ "$SHRI_COOKIE_PATH" = / ]; then cookie="__Host-shri_login="; else cookie="__Secure-shri_login="; fi
    printf '%s' "$headers" | tr -d '\r' | grep -i "^set-cookie: $cookie" | grep -qi "path=$SHRI_COOKIE_PATH\(;\|$\)" \
        || die "the login cookie is not ${cookie%=} with Path=$SHRI_COOKIE_PATH"
    "${curl[@]}" "$E${location#"$P"}" | grep -q 'id="kc-form-login"' \
        || die "Keycloak does not show its sign-in page for $P (the client's redirect URI?)"
    [ "$("${curl[@]}" -o /dev/null -w '%{http_code}' "$E/kc/admin/" 2>/dev/null || true)" = 404 ] \
        || die "the Keycloak admin console is reachable on the public host"
    # The development sign-in is never reachable from outside: the header is stripped and refused.
    [ "$("${curl[@]}" -o /dev/null -w '%{http_code}' -H 'X-Dev-User: md' "$E/api/v1/me" 2>/dev/null || true)" = 401 ] \
        || die "a request with X-Dev-User was not refused"
    # Patient sign-in: off (503) unless SHRI_PATIENT_SIGN_IN=true; when on, it starts at the
    # patient realm's public address, comes back to the portal callback, and Keycloak shows its
    # sign-in page for it.
    if [ "${SHRI_PATIENT_SIGN_IN:-false}" = true ]; then
        headers="$("${curl[@]}" -o /dev/null -D - "$E/api/v1/portal/auth/login")"
        location="$(printf '%s' "$headers" | tr -d '\r' | sed -n 's/^[Ll]ocation: *//p')"
        case "$location" in "$P/kc/realms/shri-patients/protocol/openid-connect/auth?"*) ;;
            *) die "patient sign-in does not start at $P/kc/realms/shri-patients" ;; esac
        case "$location" in *"redirect_uri=$(printf '%s' "$P/api/v1/portal/auth/callback" | sed 's/:/%3A/g; s|/|%2F|g')"*) ;;
            *) die "patient sign-in does not come back to $P/api/v1/portal/auth/callback" ;; esac
        printf '%s' "$headers" | tr -d '\r' | grep -i "^set-cookie: ${cookie%shri_login=}shri_portal_login=" \
            | grep -qi "path=$SHRI_COOKIE_PATH\(;\|$\)" \
            || die "the patient login cookie is not ${cookie%shri_login=}shri_portal_login with Path=$SHRI_COOKIE_PATH"
        "${curl[@]}" "$E${location#"$P"}" | grep -q 'id="kc-form-login"' \
            || die "Keycloak does not show the patient sign-in page for $P (the client's redirect URI?)"
    else
        [ "$("${curl[@]}" -o /dev/null -w '%{http_code}' "$E/api/v1/portal/auth/login" 2>/dev/null || true)" = 503 ] \
            || die "patient sign-in answers although SHRI_PATIENT_SIGN_IN is not true"
    fi
    # No query string, so no download token, ever reaches Nginx's log (D105).
    local probe
    probe="deploycheck$(openssl rand -hex 16)"
    "${curl[@]}" -o /dev/null "$E/api/v1/files/00000000-0000-4000-8000-000000000000/content?token=$probe" 2>/dev/null || true
    "${curl[@]}" -o /dev/null "$E/api/v1/portal/me/files/00000000-0000-4000-8000-000000000000/content?token=$probe" 2>/dev/null || true
    sleep 1
    if $DC logs --no-log-prefix --since 2m nginx 2>&1 | grep -q "$probe"; then
        die "a query string reached Nginx's access log"
    fi
    # The screens: each app's page with its assets under the base path, a screen route falls back
    # to it, and the security headers apply there too (an add_header in a location replaces the
    # server's).
    local page app path src
    # The patient portal's base is fixed at /portal/ (frontend/vite.portal.config.ts), so it is
    # served on a host of its own only; under a base path its assets would point outside.
    for app in "/ /patients $B/assets/" "/clinician/ /clinician/op-queue $B/clinician/assets/" \
               "/portal/ /portal/appointments /portal/assets/"; do
        set -- $app
        page="$("${curl[@]}" "$E$1")"
        case "$page" in *'<div id="root"'*) ;; *) die "$1 does not serve its screens" ;; esac
        case "$page" in *"\"$3"*) ;; *) die "$1's assets are not under $3" ;; esac
        [ "$("${curl[@]}" "$E$2")" = "$page" ] || die "the screen route $2 does not get $1's index.html"
        # Every script the page loads is served as JavaScript, not the page's fallback HTML (a file
        # left out of the image, such as public/theme-init.js, falls back to index.html).
        for src in $(printf '%s' "$page" | grep -o '<script[^>]* src="[^"]*"' | sed 's/.* src="\([^"]*\)"/\1/'); do
            case "$("${curl[@]}" -o /dev/null -w '%{content_type}' "$E${src#"$B"}")" in
                *javascript*) ;;
                *) die "$1 loads $src, which is not served as JavaScript" ;;
            esac
        done
        headers="$("${curl[@]}" -o /dev/null -D - "$E$1")"
        for h in "content-security-policy: default-src 'self'" "x-frame-options: DENY" \
                 "strict-transport-security: $SHRI_HSTS" "cache-control: no-store"; do
            printf '%s' "$headers" | tr -d '\r' | grep -qi "^$h" || die "$1 is missing the header: $h"
        done
        # Inline scripts are allowed on Keycloak's pages only, never on ours.
        ! printf '%s' "$headers" | tr -d '\r' | grep -i "^content-security-policy:" | grep -qi "script-src" \
            || die "$1's Content-Security-Policy has a script-src: only Keycloak's pages may run inline scripts"
    done
    # Keycloak's sign-in page keeps the security headers, with its own policy (nginx /kc/).
    headers="$("${curl[@]}" -o /dev/null -D - "$E/kc/realms/shri-staff/account")" || true
    for h in "content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'" \
             "x-frame-options: DENY" "strict-transport-security: $SHRI_HSTS"; do
        printf '%s' "$headers" | tr -d '\r' | grep -qi "^$h" || die "Keycloak's pages are missing the header: $h"
    done
    printf '%s' "$headers" | tr -d '\r' | grep -i "^content-security-policy:" | grep -q "frame-ancestors 'none'" \
        || die "Keycloak's pages may be framed (frame-ancestors)"
    # Without the authenticator code (SHRI_DEMO_SKIP_AUTH_CODE), every sign-in must leave a record:
    # both realms store their sign-in events.
    if [ "${SHRI_DEMO_SKIP_AUTH_CODE:-false}" = true ]; then
        KC_URL="http://127.0.0.1:${SHRI_KC_ADMIN_PORT:-8081}/kc" KC_ADMIN="$KEYCLOAK_ADMIN" \
            KC_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" DEMO_PASSWORD="$DEMO_PASSWORD" \
            DEMO_EVENTS_CHECK_ONLY=1 sh "$REPO/infra/keycloak/reset-demo-users.sh" \
            || die "the authenticator code is skipped, but sign-in events aren't stored in both realms"
    fi
    # The screens' build stamp names this release, never "commit unknown".
    for app in front-office clinician; do
        $DC exec -T nginx sh -c "grep -q 'commit $SHRI_RELEASE' /srv/shri-web/$app/assets/*.js" \
            || die "the $app screens don't show this release in their build stamp"
    done
    # Nothing of ours listens beyond 127.0.0.1, except our edge on a host of our own.
    local mapping
    while read -r mapping; do
        [ -n "$mapping" ] || continue
        case "$mapping" in 127.0.0.1:*) continue ;; esac
        if ! behind_host; then
            case "$mapping" in "0.0.0.0:$SHRI_HTTPS_PORT->443/tcp"|"[::]:$SHRI_HTTPS_PORT->443/tcp") continue ;; esac
        fi
        die "a port of ours is open beyond 127.0.0.1: $mapping"
    done < <(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' \
        | tr ',' '\n' | sed 's/^ *//' | grep -- '->' || true)
    # Mailpit: on a demo host, its one published port is the UI on 127.0.0.1 (never its SMTP
    # port, never another address), and the UI and its API refuse anyone without the demo-admin
    # password. Anywhere else it must not run at all.
    local mp_maps mp_code
    mp_maps="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.service=mailpit" --format '{{.Ports}}' \
        | tr ',' '\n' | sed 's/^ *//' | grep -- '->' || true)"
    if [ "${SHRI_DEMO:-false}" = true ]; then
        [ "$mp_maps" = "127.0.0.1:$SHRI_MAILPIT_UI_PORT->8025/tcp" ] \
            || die "Mailpit must publish only its UI, on 127.0.0.1:$SHRI_MAILPIT_UI_PORT (it has: ${mp_maps:-nothing})"
        local mp="http://127.0.0.1:$SHRI_MAILPIT_UI_PORT$SHRI_MAILPIT_WEBROOT"
        for _ in $(seq 1 30); do
            mp_code="$(curl -sS -o /dev/null -w '%{http_code}' "$mp" 2>/dev/null || true)"
            [ "$mp_code" = 000 ] || break
            sleep 1
        done
        [ "$mp_code" = 401 ] || die "Mailpit's UI answers $mp_code without the demo-admin password (401 expected)"
        # The password reaches curl on stdin (-K -), never its command line.
        curl -fsS -o /dev/null -K - "${mp}api/v1/info" <<<"user = \"demo-admin:$(cat "$SHRI_STATE_DIR/mailpit/ui-password")\"" \
            || die "Mailpit's UI refuses the demo-admin password in $SHRI_STATE_DIR/mailpit/ui-password"
    elif [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=mailpit")" ]; then
        die "Mailpit runs on a host that isn't a demo host (SHRI_DEMO=false): run deploy.sh up to remove it"
    fi
    if behind_host; then
        # The public address, through the host's Nginx and its real certificate (the system's
        # trust store; CHECK_PUBLIC_CACERT for a test host's own).
        local pub=(curl -fsS ${CHECK_PUBLIC_CACERT:+--cacert "$CHECK_PUBLIC_CACERT"})
        if "${pub[@]}" -o /dev/null "$P/health" 2>/dev/null; then
            [ "$("${pub[@]}" "$P/health")" = '{"status":"ok"}' ] || die "$P/health is not ok"
            [ "$("${pub[@]}" -o /dev/null -w '%{http_code}' -H 'X-Dev-User: md' "$P/api/v1/me" 2>/dev/null || true)" = 401 ] \
                || die "a request with X-Dev-User was not refused at $P"
            "${pub[@]}" "$P/" | grep -q "\"$B/assets/" || die "$P/ does not serve the front office"
            location="$("${pub[@]}" -o /dev/null -w '%{redirect_url}' "$P/api/v1/auth/login")"
            "${pub[@]}" "$location" | grep -q 'id="kc-form-login"' || die "sign-in at $P does not reach Keycloak's page"
            headers="$("${pub[@]}" -o /dev/null -D - "$P/")"
            for h in "strict-transport-security: max-age=" "content-security-policy: default-src 'self'" "x-frame-options: DENY"; do
                printf '%s' "$headers" | tr -d '\r' | grep -qi "^$h" || die "$P/ is missing the header: $h"
            done
            ! printf '%s' "$headers" | tr -d '\r' | grep -i "^content-security-policy:" | grep -qi "script-src" \
                || die "$P/ allows inline scripts: only Keycloak's pages may"
            # Keycloak's page through the host: its own policy, still never framed (host-nginx /kc/).
            headers="$("${pub[@]}" -o /dev/null -D - "$location")"
            printf '%s' "$headers" | tr -d '\r' | grep -i "^content-security-policy:" \
                | grep "script-src 'self' 'unsafe-inline'" | grep -q "frame-ancestors 'none'" \
                || die "Keycloak's page at $P doesn't get its policy: rerun deploy.sh host-nginx and install the file (README)"
            printf '%s' "$headers" | tr -d '\r' | grep -qi "^x-frame-options: DENY" \
                || die "Keycloak's page at $P is missing X-Frame-Options"
            if [ "${SHRI_DEMO:-false}" = true ]; then
                # Mailpit's UI at $P/mail/ (host-nginx): the host's password prompt first. Mailpit
                # asks for the same password itself, so an older site file only leaves it unserved.
                headers="$(curl -sS ${CHECK_PUBLIC_CACERT:+--cacert "$CHECK_PUBLIC_CACERT"} -o /dev/null -D - "$P/mail/" 2>/dev/null || true)"
                if printf '%s' "$headers" | tr -d '\r' | grep -qi '^HTTP/[0-9.]* 401'; then
                    printf '%s' "$headers" | tr -d '\r' | grep -qi '^x-robots-tag: noindex' \
                        || die "$P/mail/ is missing X-Robots-Tag: noindex: rerun deploy.sh host-nginx and install the file"
                else
                    say "$P/mail/ doesn't ask for the demo-admin password: the host's Nginx site predates Mailpit (deploy.sh host-nginx, README)"
                fi
            fi
            say "Public address $P: TLS, health, sign-in, headers and the dev header refusal checked"
        else
            say "Public address $P not reachable yet: the host's Nginx site isn't in place (deploy.sh host-nginx, README)"
        fi
    fi
    say "All checks passed: $P (release $SHRI_RELEASE, ${SHRI_ENVIRONMENT:-staging}, demo ${SHRI_DEMO:-false})"
}

# Behind a shared host's Nginx: writes the site file for it into SHRI_STATE_DIR/host-nginx/, with
# our edge's certificate for the local hop. Someone with sudo installs them once (README).
host_nginx() {
    behind_host || die "host-nginx is for SHRI_SITE_URL (behind a shared host's Nginx)"
    local dir="$SHRI_STATE_DIR/host-nginx" cert key file listen=""
    mkdir -p "$dir"
    cp "$TLS_CERT_FILE" "$dir/upstream.crt"
    cert="${HOST_TLS_CERT:-/etc/letsencrypt/live/$SHRI_HOSTNAME/fullchain.pem}"
    key="${HOST_TLS_KEY:-/etc/letsencrypt/live/$SHRI_HOSTNAME/privkey.pem}"
    local proxy
    proxy="$(cat <<EOF
        # Shri Health ($PROJECT, release $SHRI_RELEASE): written by deploy.sh host-nginx.
        proxy_pass https://127.0.0.1:$SHRI_HTTPS_PORT/;
        proxy_redirect off;               # ours are relative or already public
        proxy_http_version 1.1;
        proxy_ssl_server_name on;         # our edge's own certificate, checked on this local hop
        proxy_ssl_name $SHRI_HOSTNAME;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/nginx/shri/$PROJECT-upstream.crt;
        proxy_set_header Host $SHRI_HOSTNAME;
        proxy_set_header X-Forwarded-For \$remote_addr;   # replaced, never appended: no spoofing
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_set_header X-Dev-User "";               # never from outside (our edge strips them too)
        proxy_set_header X-Dev-Patient "";
        proxy_set_header X-Dev-Patient-Clinic "";
        proxy_buffering off;                          # live updates (Server-Sent Events)
        proxy_read_timeout 1h;
        client_max_body_size 25m;
        # The headers browsers get are this host's, the same as our edge's: HSTS without
        # includeSubDomains (the host's other names aren't ours), our CSP and the rest.
        proxy_hide_header Strict-Transport-Security;
        proxy_hide_header Content-Security-Policy;
        proxy_hide_header X-Frame-Options;
        proxy_hide_header X-Content-Type-Options;
        proxy_hide_header Referrer-Policy;
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
EOF
)"
    # Keycloak's pages (/kc/) get Keycloak's policy, as our edge gives them (nginx/shri.conf.template:
    # its inline scripts carry per-request values, so 'unsafe-inline' for them only); the full
    # path goes through unchanged.
    local kc_proxy
    kc_proxy="$(printf '%s\n' "$proxy" \
        | sed "s|proxy_pass https://127.0.0.1:$SHRI_HTTPS_PORT/;|proxy_pass https://127.0.0.1:$SHRI_HTTPS_PORT/kc/;|; \
               s|add_header Content-Security-Policy \"default-src 'self'; img-src|add_header Content-Security-Policy \"default-src 'self'; script-src 'self' 'unsafe-inline'; img-src|; \
               s|frame-ancestors 'none'; base-uri 'self'; form-action 'self'\" always;|frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'\" always;|")"
    printf '%s' "$kc_proxy" | grep -q "proxy_pass https://127.0.0.1:$SHRI_HTTPS_PORT/kc/;" \
        && printf '%s' "$kc_proxy" | grep -q "script-src 'self' 'unsafe-inline'" \
        || die "host-nginx: could not build the /kc/ block"
    # Mailpit's UI at <base path>/mail/, on a demo host only: the host's Nginx asks for the
    # demo-admin password (the htpasswd hash only, copied here; the password stays in the state
    # dir), and Mailpit checks it again. Its webroot is this path, so the path goes through as is.
    local mail=""
    rm -f "$dir/mail.htpasswd"
    if [ "${SHRI_DEMO:-false}" = true ]; then
        (umask 077; cp "$SHRI_MAILPIT_AUTH_FILE" "$dir/mail.htpasswd")
        mail="$(cat <<EOF
location ^~ $SHRI_MAILPIT_WEBROOT {
    # Mailpit, the demo mail catcher ($PROJECT, demo host only): written by deploy.sh host-nginx.
    auth_basic "Shri Health demo mail";
    auth_basic_user_file /etc/nginx/shri/$PROJECT-mail.htpasswd;
    proxy_pass http://127.0.0.1:$SHRI_MAILPIT_UI_PORT;   # no URI: Mailpit's webroot is $SHRI_MAILPIT_WEBROOT
    proxy_redirect off;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;                     # its live updates (WebSocket) check the origin
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Dev-User "";
    proxy_set_header X-Dev-Patient "";
    proxy_set_header X-Dev-Patient-Clinic "";
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 1m;
    proxy_hide_header Cache-Control;
    proxy_hide_header X-Frame-Options;
    proxy_hide_header X-Robots-Tag;
    add_header Cache-Control "no-store" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;   # its message preview is a same-origin frame
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
}

EOF
)"
    fi
    [ "$SHRI_PUBLIC_PORT" = 443 ] || listen="$SHRI_PUBLIC_PORT"
    if [ -z "$SHRI_BASE_PATH" ]; then
        file="$dir/$SHRI_HOSTNAME.conf"
        {
            echo "# $SHRI_HOSTNAME -> Shri Health on 127.0.0.1:$SHRI_HTTPS_PORT (a host of its own; README)."
            echo "# Install: /etc/nginx/sites-available/$SHRI_HOSTNAME, linked from sites-enabled."
            [ -n "$listen" ] || cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $SHRI_HOSTNAME;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}

EOF
        } >"$file"
        cat >>"$file" <<EOF
server {
    listen ${listen:-443} ssl http2;
    listen [::]:${listen:-443} ssl http2;
    server_name $SHRI_HOSTNAME;
    ssl_certificate     $cert;
    ssl_certificate_key $key;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;

$mail
    location ^~ /kc/ {
$kc_proxy
    }

    location / {
$proxy
    }
}
EOF
    else
        file="$dir/$SHRI_HOSTNAME$(printf '%s' "$SHRI_BASE_PATH" | tr / -).locations.conf"
        cat >"$file" <<EOF
# https://$SHRI_HOSTNAME$SHRI_BASE_PATH/ -> Shri Health on 127.0.0.1:$SHRI_HTTPS_PORT (a path under
# a shared host; README "Two ways to serve it": read its security notes). Install: include this
# file INSIDE the existing "listen 443 ssl" server block of $SHRI_HOSTNAME, never the port 80 one.
location = $SHRI_BASE_PATH {
    return 301 $SHRI_BASE_PATH/;
}

$mail
location ^~ $SHRI_BASE_PATH/kc/ {
$kc_proxy
}

location ^~ $SHRI_BASE_PATH/ {
$proxy
}
EOF
    fi
    say "Wrote $file and $dir/upstream.crt (README: the one-time sudo commands)"
    [ -z "$mail" ] || say "and $dir/mail.htpasswd for Mailpit's /mail/ (demo host; README: Mailpit)"
}

up() {
    say "Release $SHRI_RELEASE to $SHRI_PUBLIC_URL"
    if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
        die "the checkout has uncommitted changes: deploy a commit"
    fi
    guard_ours
    say "Images: third-party ones pinned by digest, ours built from this commit"
    $DC pull --quiet --ignore-buildable
    $DC build --quiet postgres keycloak api nginx
    say "Database and OpenBao"
    $DC up -d postgres openbao
    unseal
    say "The rest of the stack"
    # The one-shot setups (buckets, Keycloak's database) are safe to repeat; SeaweedFS reports
    # healthy a little before its filer listens, so a first try can lose that race.
    for attempt in 1 2 3; do
        $DC up -d --remove-orphans && break
        [ "$attempt" = 3 ] && die "the stack did not start; see: $DC logs"
        echo "deploy: starting again in 10 seconds (attempt $attempt of 3)" >&2
        sleep 10
    done
    # Nginx renders its template only when it starts, and compose doesn't restart it for a
    # changed mounted file: recreate it so this commit's template (and certificate) is what runs.
    $DC up -d --no-deps --force-recreate nginx
    # A host that stopped being a demo host: compose leaves a service of an inactive profile
    # running, so Mailpit (and the mail it caught) is removed here.
    if [ "${SHRI_DEMO:-false}" != true ]; then
        $DC rm --stop --force mailpit >/dev/null 2>&1 || true
    fi
    say "Migrations (shri_migrator)"
    migrate
    sync_clients
    if [ "${SHRI_DEMO:-false}" = true ]; then
        demo_reset
    fi
    check
}

[ $# -eq 2 ] || die "usage: deploy.sh {init-env|up|check|reset|down|host-nginx} SETTINGS_FILE"
case "$1" in
    init-env) init_env "$2" ;;
    up) load_env "$2"; up ;;
    check) load_env "$2"; check ;;
    reset) load_env "$2"; reset ;;
    down) load_env "$2"; $DC down ;;
    host-nginx) load_env "$2"; host_nginx ;;
    *) die "usage: deploy.sh {init-env|up|check|reset|down|host-nginx} SETTINGS_FILE" ;;
esac
