"""public_db against the real schema, as shri_public (D96, migration 0009). Needs TEST_DATABASE_URL,
migrated to head; skipped otherwise.

The route is a test stand-in with the contract's operationId (submitPreRegistration), calling
admin.submit_pre_registration() as the real endpoint does. Synthetic values only.
"""

import hashlib
import json
import secrets
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.deps import public_db
from app.core.operations import OPERATIONS_PATH_ENV, operations_file
from app.core.routing import API_PREFIX
from app.core.tests.stand_ins import include_first
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    make_tenant,
    switch_to_role,
)
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

PORTAL = "https://portal.example.test"
SECRET = secrets.token_hex(32)  # made at run time: no secret-like literal in the source
FORM = "/portal/practices/{practiceLinkId}/pre-registrations"
DETAILS = {"name": {"given": ["Kaia401"], "family": "Lindgren118"}, "birthDate": "1990-03-14",
           "phones": [{"number": "+12175550142", "use": "mobile"}]}
CALL = text("SELECT admin.submit_pre_registration(:code, :key, :hash, CAST(:details AS jsonb), "
            "true, CAST(:ip AS inet), :ua, :cid)")


def _router(seen: dict[str, Any]) -> APIRouter:
    router = APIRouter()

    @router.post(FORM, operation_id="submitPreRegistration", status_code=204,
                 response_class=Response)
    async def submit(practiceLinkId: str, request: Request,  # noqa: N803 (contract name)
                     db: AsyncSession = Depends(public_db)) -> Response:
        seen["role"] = (await db.execute(text("SELECT current_user"))).scalar_one()
        seen["tenant"] = (await db.execute(text(
            "SELECT current_setting('app.current_tenant_id', true)"))).scalar_one()
        body = await request.body()
        await db.execute(CALL, {"code": practiceLinkId, "key": request.headers["Idempotency-Key"],
                                "hash": hashlib.sha256(body).hexdigest(),
                                "details": json.dumps(DETAILS), "ip": "192.0.2.10",
                                "ua": "test", "cid": "test-request"})
        if request.headers.get("X-Test-Commit", "yes") == "yes":
            await db.commit()
        return Response(status_code=204)

    return router


@pytest.fixture
def operations_with_the_form(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """main's map predates #89's operation; add it as the contract defines it."""
    current = json.loads(operations_file().read_text(encoding="utf-8"))
    current["operations"].setdefault("submitPreRegistration", {
        "method": "POST", "path": f"{API_PREFIX}{FORM}", "permission": "public",
        "audit": {"action": "C", "category": "phi-write", "actor": "anonymous"},
        "idempotency": "required"})
    path = tmp_path / "operations.json"
    path.write_text(json.dumps(current), encoding="utf-8")
    monkeypatch.setenv(OPERATIONS_PATH_ENV, str(path))


@pytest.fixture
def practice(admin_engine: Engine) -> dict[str, Any]:  # noqa: F811
    tenant = make_tenant(admin_engine)
    code = f"test-link-{uuid4().hex}"
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.tenant SET pre_registration_code = :c, "
                       "pre_registration_enabled = true WHERE id = :t"), {"c": code, "t": tenant})
    return {"tenant": tenant, "code": code}


@pytest.fixture
def make_client(operations_with_the_form: None
                ) -> Iterator[Callable[..., tuple[TestClient, dict[str, Any]]]]:
    clients: list[TestClient] = []

    def _make(**overrides: Any) -> tuple[TestClient, dict[str, Any]]:
        values: dict[str, Any] = {
            "environment": "test", "auth_mode": "dev_header", "database_url": TEST_DATABASE_URL,
            "public_database_url": TEST_DATABASE_URL, "portal_origin": PORTAL,
            "public_form_secret": SecretStr(SECRET)}
        values.update(overrides)
        app = create_app(Settings(**values))
        if app.state.public_db is not None:
            switch_to_role(app.state.public_db.engine.sync_engine, "shri_public",
                           require_search_path=False)
        seen: dict[str, Any] = {}
        include_first(app, _router(seen), prefix=API_PREFIX)
        client = TestClient(app, raise_server_exceptions=False)
        client.__enter__()
        clients.append(client)
        return client, seen

    yield _make
    for client in clients:
        client.__exit__(None, None, None)


def _post(client: TestClient, code: str, origin: str | None = PORTAL,
          **headers: str) -> Any:
    sent = {"Idempotency-Key": str(uuid4()), "Content-Type": "application/json", **headers}
    if origin is not None:
        sent["Origin"] = origin
    return client.post(f"{API_PREFIX}/portal/practices/{code}/pre-registrations",
                       content=json.dumps({"details": DETAILS}), headers=sent)


def _stored(admin: Engine, tenant: UUID) -> tuple[int, int]:
    with admin.connect() as c:
        requests = c.execute(text("SELECT count(*) FROM admin.pre_registration "
                                  "WHERE tenant_id = :t"), {"t": tenant}).scalar_one()
        audits = c.execute(text("SELECT count(*) FROM audit.audit_event WHERE tenant_id = :t "
                                "AND actor_type = 'anonymous'"), {"t": tenant}).scalar_one()
    return int(requests), int(audits)


def test_a_submission_runs_as_shri_public_with_no_clinic_and_one_audit_row(
        make_client: Callable[..., tuple[TestClient, dict[str, Any]]],
        practice: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    client, seen = make_client()
    assert _post(client, practice["code"]).status_code == 204
    assert seen["role"] == "shri_public"
    assert seen["tenant"] in (None, "")  # the function resolves the clinic, not core
    # The function's own anonymous row; core added none (it starts no trail on public_db).
    assert _stored(admin_engine, practice["tenant"]) == (1, 1)


def test_the_public_role_can_read_no_table(
        make_client: Callable[..., tuple[TestClient, dict[str, Any]]]) -> None:
    client, _ = make_client()
    app = cast(FastAPI, client.app)

    @app.get("/probe")
    async def probe(db: AsyncSession = Depends(public_db)) -> dict[str, str]:
        try:
            await db.execute(text("SELECT count(*) FROM admin.pre_registration"))
        except Exception as error:  # noqa: BLE001 (the refusal is the point)
            return {"refused": type(getattr(error, "orig", error)).__name__}
        return {"refused": "no"}

    answer = client.get("/probe", headers={"Origin": PORTAL}).json()
    assert answer["refused"] != "no"  # permission denied for shri_public


@pytest.mark.parametrize("origin", [None, "https://evil.example.test", f"{PORTAL}/"])
def test_a_request_from_anywhere_but_the_portal_is_refused_before_anything_is_stored(
        make_client: Callable[..., tuple[TestClient, dict[str, Any]]],
        practice: dict[str, Any], admin_engine: Engine, origin: str | None) -> None:  # noqa: F811
    client, seen = make_client()
    refused = _post(client, practice["code"], origin=origin)
    assert refused.status_code == 403
    assert refused.json()["code"] == "csrf-check-failed"
    assert seen == {}  # the endpoint never ran
    assert _stored(admin_engine, practice["tenant"]) == (0, 0)


def test_nothing_is_saved_unless_the_endpoint_commits(
        make_client: Callable[..., tuple[TestClient, dict[str, Any]]],
        practice: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    client, _ = make_client()
    assert _post(client, practice["code"], **{"X-Test-Commit": "no"}).status_code == 204
    assert _stored(admin_engine, practice["tenant"]) == (0, 0)


def test_without_a_public_database_the_form_is_503(
        make_client: Callable[..., tuple[TestClient, dict[str, Any]]],
        practice: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    client, seen = make_client(public_database_url=None)
    assert _post(client, practice["code"]).status_code == 503
    assert seen == {}
    assert _stored(admin_engine, practice["tenant"]) == (0, 0)


async def _public_role_bypasses_rls(app: Any) -> bool:
    return bool(await app.state.public_db.role_bypasses_rls())


def test_the_public_role_never_bypasses_row_level_security(
        make_client: Callable[..., tuple[TestClient, dict[str, Any]]]) -> None:
    """What /ready checks for the public forms' role, as for the API's (D23)."""
    client, _ = make_client()
    assert client.portal is not None
    assert client.portal.call(_public_role_bypasses_rls, client.app) is False
