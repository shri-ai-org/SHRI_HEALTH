"""POST /patients/{patientId}/break-glass against the real schema, as shri_app (D37, D53):
the 4-hour grant, its audit row and event, the refusals, and that ensure_chart_access() opens
the chart with it afterwards.

Needs TEST_DATABASE_URL, migrated to head (app/db/tests/conftest.py). Skipped otherwise.
Synthetic patients and staff only.
"""

import datetime as dt
import logging
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.access import ensure_chart_access
from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, require, tenant_db
from app.core.routing import API_PREFIX
from app.core.tests.stand_ins import include_first
from app.db.models import MAPPERS as M
from app.db.tests import builders as b
from app.db.tests.conftest import (  # noqa: F401  (fixtures)
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    admin_engine,
    app_engine,
    db,
    make_tenant,
    open_session,
    switch_to_role,
    tenant,
)
from app.main import create_app

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

FACILITY = UUID("fa000000-0000-4000-8000-0000000000f1")
REASON_TEXT = "Covering the on-call list for the practice tonight"


def _chart_router() -> APIRouter:
    router = APIRouter()

    @router.get("/patients/{patientId}", operation_id="getPatient")
    async def get_patient(patientId: UUID,  # noqa: N803 (contract name)
                          user: CurrentUser = Depends(require("patients:read")),
                          session: AsyncSession = Depends(tenant_db)) -> dict[str, Any]:
        return {"access": (await ensure_chart_access(session, user, patientId)).value}

    return router


@pytest.fixture
def chart(db: Session, tenant: UUID) -> dict[str, Any]:  # noqa: F811
    staff = b.practitioner(db, "Halvorsen64", "Rowan318")
    patient = b.patient(db, "Lindgren118", "Kaia401")
    other = b.patient(db, "Okonkwo77", "Ines12")
    db.commit()
    return {"tenant": tenant, "user_id": staff["user"].id,
            "practitioner_id": staff["practitioner"].id, "patient": patient.id,
            "other": other.id}


@pytest.fixture
def signed_in(chart: dict[str, Any]) -> dict[str, CurrentUser]:
    return {"user": CurrentUser(id=chart["user_id"], organization_id=chart["tenant"],
                                roles=frozenset({"MD"}), facility_ids=frozenset({FACILITY}),
                                display_name="Rowan318 Halvorsen64")}


@pytest.fixture
def client(signed_in: dict[str, CurrentUser]) -> Iterator[TestClient]:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    include_first(app, _chart_router(), prefix=API_PREFIX)
    app.dependency_overrides[current_user] = lambda: signed_in["user"]
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
        assert c.portal is not None
        c.portal.call(app.state.db.dispose)


def _url(patient_id: UUID) -> str:
    return f"{API_PREFIX}/patients/{patient_id}/break-glass"


def _restrict(admin: Engine, patient_id: UUID) -> None:
    with admin.begin() as c:
        c.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R']::varchar[] "
                       "WHERE id = :p"), {"p": patient_id})


def _grants(admin: Engine, patient_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT id, user_id, reason_code, reason_text, granted_at, expires_at "
            "FROM audit.break_glass_access WHERE patient_id = :p"), {"p": patient_id}))


def _audit(admin: Engine, tenant_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT action, outcome, category, patient_id, reason FROM audit.audit_event "
            "WHERE tenant_id = :t ORDER BY id"), {"t": tenant_id}))


def _events(admin: Engine, tenant_id: UUID) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT type, subject, patient_id, data FROM admin.event_log WHERE tenant_id = :t"),
            {"t": tenant_id}))


def _when(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def test_a_grant_opens_the_restricted_chart_for_four_hours(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    assert client.get(f"{API_PREFIX}/patients/{chart['patient']}").json()["code"] == (
        "break-glass-required")

    r = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"})

    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"id", "patientId", "userId", "reasonCode", "grantedAt", "expiresAt"}
    assert (body["patientId"], body["userId"], body["reasonCode"]) == (
        str(chart["patient"]), str(chart["user_id"]), "emergency-care")
    assert _when(body["expiresAt"]) - _when(body["grantedAt"]) == dt.timedelta(hours=4)
    (grant,) = _grants(admin_engine, chart["patient"])
    assert (str(grant.id), grant.user_id, grant.reason_code, grant.reason_text) == (
        body["id"], chart["user_id"], "emergency-care", None)
    # ensure_chart_access now lets this user in, through the grant
    assert client.get(f"{API_PREFIX}/patients/{chart['patient']}").json() == {
        "access": "break-glass"}


def test_the_grant_is_audited_as_security_with_its_reason(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])

    r = client.post(_url(chart["patient"]), json={"reasonCode": "other",
                                                   "reasonText": REASON_TEXT})

    assert r.status_code == 200
    (row,) = _audit(admin_engine, chart["tenant"])
    assert (row.action, row.outcome, row.category, row.patient_id) == (
        "break-glass", "success", "security", chart["patient"])
    assert row.reason == f"other: {REASON_TEXT}"
    (grant,) = _grants(admin_engine, chart["patient"])
    assert grant.reason_text == REASON_TEXT


def test_the_grant_raises_its_internal_event_with_ids_only(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])

    grant_id = client.post(_url(chart["patient"]),
                           json={"reasonCode": "continuity-of-care"}).json()["id"]

    (event,) = _events(admin_engine, chart["tenant"])
    assert (event.type, event.subject, event.patient_id) == (
        "break-glass.granted", f"patient/{chart['patient']}", chart["patient"])
    assert event.data == {"grantId": grant_id, "userId": str(chart["user_id"])}


def test_the_reason_text_is_never_logged(client: TestClient, chart: dict[str, Any],
                                         admin_engine: Engine,  # noqa: F811
                                         caplog: pytest.LogCaptureFixture) -> None:
    _restrict(admin_engine, chart["patient"])
    with caplog.at_level(logging.DEBUG):
        client.post(_url(chart["patient"]), json={"reasonCode": "other",
                                                  "reasonText": REASON_TEXT})
    assert REASON_TEXT not in caplog.text


def test_a_role_without_the_permission_is_refused_and_nothing_is_granted(
        client: TestClient, chart: dict[str, Any], signed_in: dict[str, CurrentUser],
        admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    signed_in["user"] = CurrentUser(id=chart["user_id"], organization_id=chart["tenant"],
                                    roles=frozenset({"FD"}), facility_ids=frozenset({FACILITY}))

    r = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"})

    assert (r.status_code, r.json()["code"]) == (403, "permission-denied")
    assert _grants(admin_engine, chart["patient"]) == []
    (row,) = _audit(admin_engine, chart["tenant"])
    assert (row.outcome, row.category) == ("denied", "security")


@pytest.mark.parametrize("body", [{"reasonCode": "other"},
                                  {"reasonCode": "other", "reasonText": "   "}])
def test_other_needs_a_reason_text(client: TestClient, chart: dict[str, Any],
                                   admin_engine: Engine, body: dict[str, str]) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])

    r = client.post(_url(chart["patient"]), json=body)

    assert (r.status_code, r.json()["code"]) == (422, "business-rule-violation")
    assert r.json()["errors"] == [{"in": "body", "pointer": "/reasonText", "code": "required"}]
    assert _grants(admin_engine, chart["patient"]) == []


@pytest.mark.parametrize("body", [{}, {"reasonCode": "curiosity"},
                                  {"reasonCode": "emergency-care", "expiresAt": "2099-01-01"},
                                  {"reasonCode": "other", "reasonText": "x" * 501}])
def test_an_invalid_body_is_422(client: TestClient, chart: dict[str, Any],
                                admin_engine: Engine, body: dict[str, str]) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])

    r = client.post(_url(chart["patient"]), json=body)

    assert (r.status_code, r.json()["code"]) == (422, "validation-failed")
    assert _grants(admin_engine, chart["patient"]) == []


def test_a_chart_that_is_not_restricted_is_409(client: TestClient,
                                               chart: dict[str, Any]) -> None:
    r = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"})
    assert (r.status_code, r.json()["code"]) == (409, "invalid-state-transition")


def test_a_second_grant_while_the_first_is_current_is_409(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    assert client.post(_url(chart["patient"]),
                       json={"reasonCode": "emergency-care"}).status_code == 200

    r = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"})

    assert (r.status_code, r.json()["code"]) == (409, "invalid-state-transition")
    assert len(_grants(admin_engine, chart["patient"])) == 1


def test_a_care_team_member_does_not_need_one(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    with admin_engine.begin() as c:
        c.execute(text(
            "INSERT INTO admin.care_team_member (id, tenant_id, patient_id, user_id, role_code, "
            "period_start) VALUES (:i, :t, :p, :u, 'PCP', current_date - 1)"),
            {"i": uuid4(), "t": chart["tenant"], "p": chart["patient"], "u": chart["user_id"]})

    r = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"})

    assert (r.status_code, r.json()["code"]) == (409, "invalid-state-transition")


def test_an_unknown_or_other_clinic_patient_is_404(
        client: TestClient, admin_engine: Engine, app_engine: Engine) -> None:  # noqa: F811
    elsewhere = make_tenant(admin_engine)
    s = open_session(app_engine, elsewhere)
    try:
        theirs = b.patient(s, "Faraday9", "Odile4").id
        s.commit()
    finally:
        connection = s.bind
        s.close()
        connection.close()  # type: ignore[union-attr]
    _restrict(admin_engine, theirs)

    for patient_id in (uuid4(), theirs):
        r = client.post(_url(patient_id), json={"reasonCode": "emergency-care"})
        assert (r.status_code, r.json()["code"]) == (404, "not-found")
    assert _grants(admin_engine, theirs) == []


def test_a_merged_patient_is_409(client: TestClient, chart: dict[str, Any], db: Session,  # noqa: F811
                                 admin_engine: Engine) -> None:  # noqa: F811
    db.add(M["patient_link"](patient_id=chart["patient"], other_patient_id=chart["other"],
                             type="replaced-by"))
    db.commit()
    _restrict(admin_engine, chart["patient"])

    r = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"})

    assert (r.status_code, r.json()["code"]) == (409, "patient-merged")


def test_a_retry_with_the_same_key_returns_the_same_grant(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:  # noqa: F811
    _restrict(admin_engine, chart["patient"])
    headers = {"Idempotency-Key": str(uuid4())}

    first = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"},
                        headers=headers)
    again = client.post(_url(chart["patient"]), json={"reasonCode": "emergency-care"},
                        headers=headers)

    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    assert len(_grants(admin_engine, chart["patient"])) == 1
