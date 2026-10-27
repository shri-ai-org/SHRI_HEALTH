"""Audit from x-audit without a database: which rows a request produces, and that a failed audit
write fails the request. The writes themselves are tested in test_audit_postgres.py."""

from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.core import audit
from app.core.audit import AuditMiddleware, AuditTrail, audit_detail, entity, event_action
from app.core.deps import DEV_USERS
from app.core.operations import load_operations

OPS = load_operations()
PATIENT = UUID("0c000000-0000-4000-8000-000000000001")


@pytest.mark.parametrize(("operation_id", "expected"), [
    ("getPatient", "read"),
    ("searchPatients", "read"),
    ("registerPatient", "create"),
    ("updatePatient", "update"),
    ("signNote", "sign"),
    ("addNoteAddendum", "sign"),
    ("createDownloadUrl", "export"),
    ("createAfterVisitSummary", "export"),
])
def test_event_action_follows_x_audit(operation_id: str, expected: str) -> None:
    assert event_action(OPS[operation_id]) == expected


def test_admin_changes_are_config_changes() -> None:
    admin_writes = [o for o in OPS.values()
                    if o.audit.category == "admin" and o.audit.action != "R"]
    assert admin_writes
    assert {event_action(o) for o in admin_writes} == {"config-change"}


def test_a_security_operation_must_name_its_action() -> None:
    with pytest.raises(RuntimeError, match="audit_detail"):
        event_action(OPS["breakGlass"])
    assert event_action(OPS["breakGlass"], "break-glass") == "break-glass"


@pytest.mark.parametrize(("operation_id", "params", "expected"), [
    ("getPatient", {"patientId": PATIENT}, ("patients", str(PATIENT))),
    ("searchPatients", {}, ("patients", None)),
    ("signNote", {"noteId": "n-1"}, ("notes", "n-1")),
])
def test_entity_names_the_record(operation_id: str, params: dict[str, Any],
                                 expected: tuple[str | None, str | None]) -> None:
    assert entity(OPS[operation_id], params) == expected


def _trail(operation_id: str, **params: Any) -> AuditTrail:
    return AuditTrail(operation=OPS[operation_id], user=DEV_USERS["md"], session=None,  # type: ignore[arg-type]
                      path_params=params, request_id="r-1", source_ip=None, user_agent=None)


def test_a_path_patient_is_recorded() -> None:
    (row,) = _trail("getPatient", patientId=str(PATIENT)).rows()
    assert row["patient_id"] == PATIENT
    assert row["tenant_id"] == DEV_USERS["md"].organization_id
    assert row["actor_user_id"] == DEV_USERS["md"].id
    assert (row["action"], row["outcome"], row["category"]) == ("read", "success", "phi-read")
    assert row["correlation_id"] == "r-1"


def test_result_patients_must_be_named_by_the_endpoint() -> None:
    trail = _trail("searchPatients")
    with pytest.raises(RuntimeError, match="audit_patients"):
        trail.rows()
    trail.patient_ids = []
    assert [r["patient_id"] for r in trail.rows()] == [None]  # a search that found nobody
    others = [uuid4(), uuid4()]
    trail.patient_ids = others
    assert [r["patient_id"] for r in trail.rows()] == others


def test_audit_detail_validates_its_input() -> None:
    request = Request({"type": "http", "state": {}, "app": FastAPI()})
    with pytest.raises(ValueError, match="Unknown audit action"):
        audit_detail(request, action="peek")
    with pytest.raises(ValueError, match="500"):
        audit_detail(request, action="break-glass", reason="x" * 501)


class _FakeTrail:
    def __init__(self, fail: bool) -> None:
        self.fail, self.written, self.request_id = fail, False, "r-1"

    async def write_now(self) -> None:
        if self.fail:
            raise RuntimeError("database down")
        self.written = True


def _middleware_app(trail: _FakeTrail, status: int) -> TestClient:
    app = FastAPI()
    app.add_middleware(AuditMiddleware)

    @app.get("/x")
    async def x(request: Request) -> JSONResponse:
        setattr(request.state, audit.TRAIL_STATE, trail)
        return JSONResponse({"name": "private"}, status_code=status)

    return TestClient(app, raise_server_exceptions=False)


def test_a_successful_response_waits_for_its_audit_rows() -> None:
    trail = _FakeTrail(fail=False)
    response = _middleware_app(trail, 200).get("/x")
    assert response.status_code == 200 and trail.written


def test_a_failed_audit_write_fails_the_request() -> None:
    response = _middleware_app(_FakeTrail(fail=True), 200).get("/x")
    assert response.status_code == 500
    assert response.json()["code"] == "internal-error"
    assert "private" not in response.text  # the endpoint's body never leaves


def test_an_error_response_writes_no_success_row() -> None:
    trail = _FakeTrail(fail=True)
    assert _middleware_app(trail, 404).get("/x").status_code == 404
    assert not trail.written
