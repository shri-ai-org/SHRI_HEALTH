#!/usr/bin/env bash
# The manual deploy for one Linux host with Docker (infra/deploy/README.md). Synthetic data only.
#
#   infra/deploy/deploy.sh init-env /etc/shri/deploy.env   # once: a new settings file, random secrets
#   infra/deploy/deploy.sh up       /etc/shri/deploy.env   # build, start, migrate, demo reset, check
#   infra/deploy/deploy.sh check    /etc/shri/deploy.env   # the health check only
#   infra/deploy/deploy.sh down     /etc/shri/deploy.env   # stop (volumes, and so the data, stay)
#
# The settings file holds every secret: it must be mode 600 and outside the repository. Secrets
# never go on a command line (where `ps` shows them) and are never printed: they reach compose
# through --env-file, OpenBao and the seed through stdin or the container environment.
# `up` deploys the commit that is checked out; the images are built from it and tagged with it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$REPO/infra/deploy"
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
# staging for the test server. production is refused with SHRI_DEMO=true.
SHRI_ENVIRONMENT=staging
# true: the simulated payer and pharmacy, the demo accounts and the demo data (D95).
SHRI_DEMO=false
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
    SHRI_HTTPS_PORT="${SHRI_HTTPS_PORT:-443}"
    if [ "$SHRI_HTTPS_PORT" = 443 ]; then SHRI_PUBLIC_URL="https://$SHRI_HOSTNAME"
    else SHRI_PUBLIC_URL="https://$SHRI_HOSTNAME:$SHRI_HTTPS_PORT"; fi
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
    export SHRI_HTTPS_PORT SHRI_PUBLIC_URL SHRI_RELEASE SHRI_BUILD_VERSION TLS_CERT_FILE TLS_KEY_FILE
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
    # The seed allows only ENVIRONMENT development or test (its guard against real data). This
    # host holds synthetic data only, so the seed process alone runs as test until the seed
    # allows staging (asked on the PR). The API and worker stay staging.
    MIGRATION_DATABASE_URL="postgresql+psycopg://shri_migrator:${SHRI_MIGRATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
        $DC run --rm --no-deps -T -e MIGRATION_DATABASE_URL -e ENVIRONMENT=test --entrypoint python api \
        -m app.db.seed demo
}

wait_for() {  # url, what
    for _ in $(seq 1 90); do
        curl -fsS "${CURL_TLS[@]}" --resolve "$SHRI_HOSTNAME:$SHRI_HTTPS_PORT:127.0.0.1" -o /dev/null "$1" 2>/dev/null && return 0
        sleep 2
    done
    die "$2 did not answer at $1"
}

check() {
    local curl=(curl -fsS "${CURL_TLS[@]}" --resolve "$SHRI_HOSTNAME:$SHRI_HTTPS_PORT:127.0.0.1")
    say "Health check ($SHRI_PUBLIC_URL)"
    wait_for "$SHRI_PUBLIC_URL/health" "the API"
    [ "$("${curl[@]}" "$SHRI_PUBLIC_URL/health")" = '{"status":"ok"}' ] || die "/health is not ok"
    $DC exec -T api python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=5)" \
        || die "/ready failed (database, OpenBao or the operations map)"
    wait_for "$SHRI_PUBLIC_URL/kc/realms/shri-staff/.well-known/openid-configuration" "Keycloak"
    for realm in shri-staff shri-patients; do
        "${curl[@]}" "$SHRI_PUBLIC_URL/kc/realms/$realm/.well-known/openid-configuration" \
            | grep -q "\"issuer\":\"$SHRI_PUBLIC_URL/kc/realms/$realm\"" || die "$realm's issuer is not $SHRI_PUBLIC_URL"
    done
    local location
    location="$("${curl[@]}" -o /dev/null -w '%{redirect_url}' "$SHRI_PUBLIC_URL/api/v1/auth/login")"
    case "$location" in "$SHRI_PUBLIC_URL/kc/realms/shri-staff/protocol/openid-connect/auth?"*) ;;
        *) die "staff sign-in does not start at Keycloak" ;; esac
    [ "$("${curl[@]}" -o /dev/null -w '%{http_code}' "$SHRI_PUBLIC_URL/kc/admin/" 2>/dev/null || true)" = 404 ] \
        || die "the Keycloak admin console is reachable on the public host"
    # The development sign-in is never reachable from outside: the header is stripped and refused.
    [ "$("${curl[@]}" -o /dev/null -w '%{http_code}' -H 'X-Dev-User: md' "$SHRI_PUBLIC_URL/api/v1/me" 2>/dev/null || true)" = 401 ] \
        || die "a request with X-Dev-User was not refused"
    # Real patient sign-in is off on servers for now (#148's account-state bug).
    [ "$("${curl[@]}" -o /dev/null -w '%{http_code}' "$SHRI_PUBLIC_URL/api/v1/portal/auth/login" 2>/dev/null || true)" = 503 ] \
        || die "patient sign-in is on; it stays off until #148's account-state bug is fixed"
    # No query string, so no download token, ever reaches Nginx's log (D105).
    local probe
    probe="deploycheck$(openssl rand -hex 16)"
    "${curl[@]}" -o /dev/null "$SHRI_PUBLIC_URL/api/v1/files/00000000-0000-4000-8000-000000000000/content?token=$probe" 2>/dev/null || true
    sleep 1
    if $DC logs --no-log-prefix --since 2m nginx 2>&1 | grep -q "$probe"; then
        die "a query string reached Nginx's access log"
    fi
    say "All checks passed: $SHRI_PUBLIC_URL (release $SHRI_RELEASE, ${SHRI_ENVIRONMENT:-staging}, demo ${SHRI_DEMO:-false})"
}

up() {
    say "Release $SHRI_RELEASE to $SHRI_PUBLIC_URL"
    if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
        die "the checkout has uncommitted changes: deploy a commit"
    fi
    say "Images: third-party ones pinned by digest, ours built from this commit"
    $DC pull --quiet --ignore-buildable
    $DC build --quiet postgres keycloak api
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
    say "Migrations (shri_migrator)"
    migrate
    if [ "${SHRI_DEMO:-false}" = true ]; then
        wait_for "$SHRI_PUBLIC_URL/kc/realms/shri-staff/.well-known/openid-configuration" "Keycloak"
        demo_reset
    fi
    check
}

[ $# -eq 2 ] || die "usage: deploy.sh {init-env|up|check|down} SETTINGS_FILE"
case "$1" in
    init-env) init_env "$2" ;;
    up) load_env "$2"; up ;;
    check) load_env "$2"; check ;;
    down) load_env "$2"; $DC down ;;
    *) die "usage: deploy.sh {init-env|up|check|down} SETTINGS_FILE" ;;
esac
