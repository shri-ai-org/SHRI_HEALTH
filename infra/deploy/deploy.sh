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
# true: the screens are built with the AI features shown (Draft with AI, chart summary, assistant,
# morning brief, differentials; the VITE_FEATURE_AI_* flags, read at build time). Only with
# SHRI_DEMO=true. Each feature still needs its per-clinic switch and the Claude key (D116, D12).
SHRI_DEMO_AI_SCREENS=false
# self-signed (a local hostname) or provided (TLS_CERT_FILE and TLS_KEY_FILE, the real certificate).
TLS_MODE=self-signed
TLS_CERT_FILE=
TLS_KEY_FILE=
# Where deploy.sh keeps OpenBao's unseal key and root token and the self-signed certificate.
SHRI_STATE_DIR=$(cd "$(dirname "$file")" && pwd)/shri-state
# Keycloak's admin console, on this host's loopback only (reach it over an SSH tunnel).
SHRI_KC_ADMIN_PORT=8081

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
    echo "Wrote $file (mode 600). Set SHRI_HOSTNAME, SHRI_HTTPS_PORT, SHRI_DEMO and TLS_* there."
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
        die "the demo (simulated partners, synthetic seed) is never deployed to production"
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
    case "${SHRI_DEMO_AI_SCREENS:-false}" in
        true) [ "${SHRI_DEMO:-false}" = true ] \
                  || die "SHRI_DEMO_AI_SCREENS=true needs SHRI_DEMO=true (fictional data only until a BAA, D12)"
              export SHRI_WEB_AI=on ;;
        false) export SHRI_WEB_AI=off ;;
        *) die "SHRI_DEMO_AI_SCREENS is true or false" ;;
    esac
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
    SHRI_BUILD_VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$REPO/backend/pyproject.toml" | head -1)"
    mkdir -p "$SHRI_STATE_DIR" && chmod 700 "$SHRI_STATE_DIR"
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
        sh "$REPO/infra/keycloak/reset-demo-users.sh"
    say "Demo data (python -m app.db.seed demo, as shri_migrator)"
    # The seed refuses staging unless SEED_ALLOW_STAGING=1 (its guard against real data, #159).
    # This host holds synthetic data only, and the demo never runs in production (checked above).
    MIGRATION_DATABASE_URL="postgresql+psycopg://shri_migrator:${SHRI_MIGRATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
        $DC run --rm --no-deps -T -e MIGRATION_DATABASE_URL -e SEED_ALLOW_STAGING=1 --entrypoint python api \
        -m app.db.seed demo
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
    say "Migrations and the demo data (python -m app.db.seed reset, as shri_migrator)"
    # The reset refuses a database that has tables and, like the seed, staging without
    # SEED_ALLOW_STAGING=1 (#159); this host is a demo host (checked above).
    MIGRATION_DATABASE_URL="postgresql+psycopg://shri_migrator:${SHRI_MIGRATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
        $DC run --rm --no-deps -T -e MIGRATION_DATABASE_URL -e SEED_ALLOW_STAGING=1 --entrypoint python api \
        -m app.db.seed reset
    load_codes
    say "Demo accounts (Keycloak, fixed IDs)"
    KC_URL="http://127.0.0.1:${SHRI_KC_ADMIN_PORT:-8081}/kc" KC_ADMIN="$KEYCLOAK_ADMIN" \
        KC_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" DEMO_PASSWORD="$DEMO_PASSWORD" \
        sh "$REPO/infra/keycloak/reset-demo-users.sh"
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
    local port net name subnets
    for port in "$SHRI_HTTPS_PORT" "${SHRI_KC_ADMIN_PORT:-8081}"; do
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
    say "Keycloak sign-in addresses: $SHRI_PUBLIC_URL"
    wait_for "$EDGE_URL/kc/realms/shri-staff/.well-known/openid-configuration" "Keycloak"
    KC_URL="http://127.0.0.1:${SHRI_KC_ADMIN_PORT:-8081}/kc" KC_ADMIN="$KEYCLOAK_ADMIN" \
        KC_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" PUBLIC_URL="$SHRI_PUBLIC_URL" \
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
    sleep 1
    if $DC logs --no-log-prefix --since 2m nginx 2>&1 | grep -q "$probe"; then
        die "a query string reached Nginx's access log"
    fi
    # The screens: each app's page with its assets under the base path, a screen route falls back
    # to it, and the security headers apply there too (an add_header in a location replaces the
    # server's).
    local page app path
    for app in "/ /patients $B/assets/" "/clinician/ /clinician/op-queue $B/clinician/assets/"; do
        set -- $app
        page="$("${curl[@]}" "$E$1")"
        case "$page" in *'<div id="root"'*) ;; *) die "$1 does not serve its screens" ;; esac
        case "$page" in *"\"$3"*) ;; *) die "$1's assets are not under $3" ;; esac
        [ "$("${curl[@]}" "$E$2")" = "$page" ] || die "the screen route $2 does not get $1's index.html"
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

location ^~ $SHRI_BASE_PATH/ {
$proxy
}
EOF
    fi
    say "Wrote $file and $dir/upstream.crt (README: the one-time sudo commands)"
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
