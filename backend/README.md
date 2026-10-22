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

- `tenant_db` is scoped to the caller's clinic (row-level security). Call `await db.commit()`
  to save; anything not committed is rolled back when the request ends.
- Raise `NotFound`, `Conflict`, `Forbidden`, `ValidationFailed` from `app/core/errors.py`.
  Never build error responses by hand.

## Stand-in login (development and test only)

Until Keycloak login is built, pick a synthetic test user with the `X-Dev-User` header:

| `X-Dev-User` | Role | Clinic |
|---|---|---|
| `doctor` | doctor | A |
| `nurse` | nurse_ma | A |
| `front-desk` | front_desk | A |
| `biller` | biller | A |
| `practice-admin` | practice_admin | A |
| `platform-admin` | platform_admin (everything) | A |
| `no-access` | none — use for permission-denied tests | A |
| `doctor-b` | doctor | B — use for cross-clinic tests |

The role-to-permission map in `app/core/permissions.py` is provisional until the contract's
`x-permission` names exist. The stand-in refuses to start in staging or production.

```python
def test_get_patient_denied(client):
    r = client.get("/api/v1/patients/...", headers={"X-Dev-User": "no-access"})
    assert r.status_code == 403
```

## Run the tests

Python 3.13:

```bash
cd backend
pip install -e ".[dev]"
pytest
ruff check . && mypy app
```

Database tests run when `TEST_DATABASE_URL` points at a throwaway PostgreSQL as a superuser,
e.g. `postgresql+asyncpg://postgres:postgres@localhost:5432/postgres`; otherwise they are skipped.

## Run the whole stack locally

```bash
cp infra/compose/example.env infra/compose/.env   # fill in the two passwords
infra/nginx/make-dev-cert.sh                      # once
docker compose -f infra/compose/docker-compose.yml up --build
```

Then open `https://localhost:8443/api/v1/health` and `https://localhost:8443/api/v1/docs`.
Keycloak is at `https://localhost:8443/kc/`. Synthetic data only.

## Settings

Environment variables (or an OpenBao KV secret when `OPENBAO_ADDR` and `OPENBAO_TOKEN` are set):
`ENVIRONMENT`, `AUTH_MODE`, `DATABASE_URL`, `RLS_TENANT_SETTING`. See `app/core/config.py`.
