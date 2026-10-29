# Shri Health API (FastAPI)

## Adding endpoints to your module

1. Create `app/modules/<your_module>/api.py` with `router = APIRouter(tags=["<your_module>"])`.
   It is picked up automatically and served under `/api/v1` — no central list to edit.
2. Every endpoint uses the building blocks from `app/core/deps.py`:

```python
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db
from app.core.errors import NotFound

router = APIRouter(tags=["patients"])


@router.get("/patients/{patient_id}")
async def get_patient(
    patient_id: UUID,
    user: CurrentUser = Depends(require("patients:read")),
    db: AsyncSession = Depends(tenant_db),
) -> PatientOut:
    ...
    raise NotFound("Patient not found")  # becomes Problem JSON
```

- `tenant_db` is scoped to the caller's clinic (row-level security). Each transaction sets
  `app.current_tenant_id`, `app.current_user_id` and `app.correlation_id` (the request ID) for
  its whole length, including triggers that run at commit. The clinic comes from the server-side
  session, never from request headers or the body. Call `await db.commit()` to save; anything
  not committed is rolled back when the request ends.
- The session also carries the clinic as `db.info["tenant_id"]` (a UUID; key
  `app.core.db.TENANT_ID_INFO_KEY`), so data-access helpers can fill `tenant_id` on new rows.
  Fill it only where it is empty, never overwrite it.
- Raise `NotFound`, `Conflict`, `Forbidden`, `ValidationFailed` from `app/core/errors.py`,
  with `code=` for a specific code from API_STANDARDS §9.3, e.g.
  `Conflict(code="booking-conflict")`. Responses use the Problem Details shape (§9.1) with
  `code` and `requestId`. Never build error responses by hand, and never put PHI in `detail`.

## Stand-in login (development and test only)

Until Keycloak login is built, pick a synthetic test user with the `X-Dev-User` header:

| `X-Dev-User` | Role | Clinic |
|---|---|---|
| `fd` | FD front desk | A |
| `ma` | MA medical assistant | A |
| `rn` | RN nurse | A |
| `md` | MD physician | A |
| `app` | APP advanced practice provider | A |
| `bil` | BIL biller | A |
| `adm` | ADM practice administrator | A |
| `co` | CO compliance / privacy officer | A |
| `sup` | SUP Shri platform support (no PHI) | A |
| `dsp` | DSP shared display (status board only) | A |
| `none` | no roles: use for permission-denied tests | A |
| `md-b` | MD | B: use for cross-clinic tests |

Permission names and the role matrix in `app/core/permissions.py` come from
`contracts/docs/SECURITY_MODEL.md` §4 (agreed in issue #3). `require()` refuses names that are
not in the catalogue, so a typo fails at startup. Use `require("authenticated")` for endpoints
any signed-in user may call. The stand-in refuses to start in staging or production.

`DSP` is a shared screen, such as a waiting-room status board, never a person. It holds only
`status-board:read`, and `user.is_shared_display` tells the status board to show initials and
appointment times only (SECURITY_MODEL §8 rule 11).

```python
def test_get_patient_denied(client):
    r = client.get("/api/v1/patients/...", headers={"X-Dev-User": "none"})
    assert r.status_code == 403
```

## Request IDs

Every response carries `X-Request-ID` (also `requestId` in error bodies). A client may send its
own as a UUID; anything else is replaced. `current_request_id()` and `current_traceparent()`
in `app/core/request_id.py` give them to log records and outbound calls.

## Run the tests

Python 3.13:

```bash
cd backend
pip install --require-hashes --no-deps -r requirements-dev.lock
pytest
ruff check . && mypy app
```

Dependencies are locked with exact versions and hashes: `requirements.lock` for the API image,
`requirements-dev.lock` for CI and laptops. `pyproject.toml` only holds the allowed ranges. To
change a dependency, edit `pyproject.toml`, then regenerate both locks with releases at least
7 days old (the same rule as the contract tools) and review the diff in the PR:

```bash
pip install uv==0.13.1
uv pip compile pyproject.toml --generate-hashes --exclude-newer <date 7 days ago>T00:00:00Z \
  --python-version 3.13 --python-platform x86_64-unknown-linux-gnu --no-header -o requirements.lock
uv pip compile pyproject.toml --extra dev --generate-hashes --exclude-newer <same date>T00:00:00Z \
  --python-version 3.13 --python-platform x86_64-unknown-linux-gnu --no-header -o requirements-dev.lock
```

Database tests run when `TEST_DATABASE_URL` points at a throwaway PostgreSQL as a superuser,
e.g. `postgresql+asyncpg://postgres:postgres@localhost:5432/postgres`; otherwise they are skipped.
Add `TEST_DATABASE_IMAGE=shri` when that database is our image (below) to also check its setup.
CI (`.github/workflows/backend.yml`) runs all of them.

### Run the checks in Docker

No Python 3.13 on your machine (Ubuntu 24.04 has 3.12), and `uv` isn't in a lockfile? Run CI's
steps in the API's own image instead, so nothing is installed on the host. It runs as your user, so
no root-owned files land in the checkout, and the virtualenv lives in a Docker volume.

1. Start the compose database and OpenBao (with `infra/compose/.env` filled in), and add the
   extensions, as CI does. Compose refuses to start *any* service while a required key is
   missing from `.env`, so after every pull run `python3 scripts/check_env.py` first and fill in
   each key it lists (for a secret, any long random value: `openssl rand -hex 32`):

   ```bash
   docker compose -f infra/compose/docker-compose.yml up -d postgres openbao openbao-init
   set -a; . infra/compose/.env; set +a   # the password reaches psql through the environment
   PGPASSWORD="$POSTGRES_PASSWORD" docker compose -f infra/compose/docker-compose.yml exec -T \
     -e PGPASSWORD postgres psql -v ON_ERROR_STOP=1 -U shri -d shri_health \
     < backend/app/db/sql/00_extensions.sql
   ```

2. Put the test settings in a private env file **outside the repository**
   (`chmod 600`), never on a command line. It needs:
   - `TEST_DATABASE_URL=postgresql+asyncpg://shri:<POSTGRES_PASSWORD>@postgres:5432/shri_health`
     and `TEST_DATABASE_IMAGE=shri`;
   - `MIGRATION_DATABASE_URL=postgresql+psycopg://shri_migrator:<SHRI_MIGRATOR_PASSWORD>@postgres:5432/shri_health`;
   - `OPENBAO_TRANSIT_ADDR=http://openbao:8200`, `OPENBAO_TRANSIT_TOKEN=<OPENBAO_API_TOKEN>` and
     `REQUIRE_OPENBAO=1`.

3. Run the checks in the image `backend/Dockerfile` pins (keep the two in step). The first line
   gives the virtualenv volume to your user, once:

   ```bash
   IMAGE=python:3.13.17-slim-trixie@sha256:fe14fd57a4c0361110eaa0c284112b189750bcb43fb04bb5d1ee7b7744027ccf
   docker run --rm -v shri-py313-venv:/venv "$IMAGE" chown "$(id -u):$(id -g)" /venv
   docker run --rm --network shri-health_default --user "$(id -u):$(id -g)" -e HOME=/tmp \
     --env-file ~/.shri-health-test.env -v "$PWD":/repo -v shri-py313-venv:/venv \
     -w /repo/backend "$IMAGE" bash -c '
       { test -x /venv/bin/python || python -m venv /venv; } &&
       /venv/bin/pip install -q --require-hashes --no-deps -r requirements-dev.lock &&
       /venv/bin/ruff check . && /venv/bin/mypy app &&
       /venv/bin/alembic -c app/db/alembic.ini upgrade head &&
       /venv/bin/alembic -c app/db/alembic.ini check &&
       /venv/bin/pytest -p no:cacheprovider -q -rs'
   ```

If the passwords in `.env` change, run `docker compose -f infra/compose/docker-compose.yml down -v`
once, so the database is created again with them. Synthetic data only.

## Run the whole stack locally

```bash
cp infra/compose/example.env infra/compose/.env   # fill in every password and secret
infra/nginx/make-dev-cert.sh                      # once
docker compose -f infra/compose/docker-compose.yml up --build
```

After every pull, `python3 scripts/check_env.py` lists any key `example.env` gained that your
`.env` lacks (names only, never values). Compose refuses to start any service while one is
missing: for example `FILE_STORE_SECRET_ACCESS_KEY` (the API's key on the development file store),
added with SeaweedFS. Give each secret its own long random value (`openssl rand -hex 32`); never
copy a real one into `example.env`.

Then open `https://localhost:8443/health` and `https://localhost:8443/api/v1/docs`.
Keycloak is at `https://localhost:8443/kc/`. Synthetic data only.

The database is `infra/compose/postgres`: PostgreSQL 18.6 with pgvector 0.8.2, the version Amazon
RDS ships (ADR-0012, D31), with data checksums, SCRAM-SHA-256, C.UTF-8 collation and UTC. On first
start it creates one role per service (D23); grants come from the migrations in `backend/app/db/`.
The API connects as `shri_app`, which cannot bypass row-level security, and `/ready` fails if it
can. Coming from the old PostgreSQL 16 stack? Run `docker compose -f infra/compose/docker-compose.yml
down -v` once: data now lives in the `pgdata18` volume. Production is Amazon RDS.

## Settings

Environment variables (or an OpenBao KV secret when `OPENBAO_ADDR` and `OPENBAO_TOKEN` are set):
`ENVIRONMENT`, `AUTH_MODE`, `PROBLEM_TYPE_BASE`, and one database URL per role (D23):
`DATABASE_URL` (`shri_app`), `FHIR_DATABASE_URL` (`shri_fhir_reader`), `INTEGRATION_DATABASE_URL`
(`shri_integration`), `REPORTING_DATABASE_URL` (`shri_reporting`), `MIGRATION_DATABASE_URL`
(`shri_migrator`, migrations only, never given to the API). See `app/core/config.py`.

`BUILD_VERSION` and `BUILD_COMMIT` are not set by hand: CI passes them as image build arguments
(`backend/Dockerfile`), and local builds show `dev` and `unknown` (Q31). They are shown to signed-in
users only, never on `/health`, and a malformed value stops startup.
