"""The patient development sign-in (patient_auth_mode=dev_header) and own-record checks (D84).

Synthetic IDs only. The routes sit outside /api/v1, so they need no contract operation.
"""

from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings
from app.core.deps import (
    DEV_PATIENT_CLINIC_HEADER,
    DEV_PATIENT_HEADER,
    DEV_USER_HEADER,
    PATIENT_ROLE,
    PORTAL_SESSION_STATE,
    PortalPatient,
    portal_session,
    require,
    require_own_record,
)

CLINIC = UUID("0a000000-0000-4000-8000-00000000000a")
PATIENT = UUID("0c000000-0000-4000-8000-0000000000b1")
OTHER_PATIENT = UUID("0c000000-0000-4000-8000-0000000000b2")
# Stand-in records: an appointment of each patient.
APPOINTMENTS = {UUID("0d000000-0000-4000-8000-0000000000a1"): PATIENT,
                UUID("0d000000-0000-4000-8000-0000000000a2"): OTHER_PATIENT}
MINE, THEIRS = list(APPOINTMENTS)


def _app(**settings: Any) -> FastAPI:
    from app.main import create_app

    values: dict[str, Any] = {"environment": "test", "auth_mode": "dev_header"}
    values.update(settings)
    app = create_app(Settings(**values))

    @app.get("/me")
    async def me(request: Request, patient: PortalPatient = Depends(portal_session)
                 ) -> dict[str, Any]:
        stored = getattr(request.state, PORTAL_SESSION_STATE)
        return {"patient": str(patient.patient_id), "clinic": str(patient.organization_id),
                "roles": sorted(patient.roles), "recorded": stored is patient}

    @app.get("/me/appointments/{appointmentId}")
    async def appointment(appointmentId: UUID,  # noqa: N803 (contract name)
                          patient: PortalPatient = Depends(portal_session)) -> dict[str, str]:
        require_own_record(patient, APPOINTMENTS.get(appointmentId))
        return {"appointment": str(appointmentId)}

    @app.get("/staff-only")
    async def staff_only(user: Any = Depends(require("patients:read"))) -> None:
        return None

    return app


def _headers(patient: UUID | str = PATIENT, clinic: UUID | str = CLINIC) -> dict[str, str]:
    return {DEV_PATIENT_HEADER: str(patient), DEV_PATIENT_CLINIC_HEADER: str(clinic)}


@pytest.fixture
def dev() -> TestClient:
    return TestClient(_app(patient_auth_mode="dev_header"), raise_server_exceptions=False)


def test_the_stand_in_signs_in_a_patient_in_development(dev: TestClient) -> None:
    r = dev.get("/me", headers=_headers())
    assert r.status_code == 200
    assert r.json() == {"patient": str(PATIENT), "clinic": str(CLINIC),
                        "roles": [PATIENT_ROLE], "recorded": True}


@pytest.mark.parametrize("headers", [
    {},
    {DEV_PATIENT_HEADER: str(PATIENT)},  # no clinic
    {DEV_PATIENT_CLINIC_HEADER: str(CLINIC)},  # no patient
    {DEV_PATIENT_HEADER: "Kaia401 Lindgren118", DEV_PATIENT_CLINIC_HEADER: str(CLINIC)},
    {DEV_PATIENT_HEADER: str(PATIENT), DEV_PATIENT_CLINIC_HEADER: "clinic-a"},
])
def test_missing_or_malformed_headers_are_refused(dev: TestClient,
                                                  headers: dict[str, str]) -> None:
    r = dev.get("/me", headers=headers)
    assert r.status_code == 401 and r.json()["code"] == "unauthenticated"


def test_the_headers_are_ignored_when_the_stand_in_is_off() -> None:
    off = TestClient(_app(), raise_server_exceptions=False)  # patient_auth_mode defaults off
    r = off.get("/me", headers=_headers())
    assert r.status_code == 401 and r.json()["code"] == "unauthenticated"


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_the_stand_in_is_refused_outside_development_and_test(environment: str) -> None:
    with pytest.raises(ValidationError, match="patient_auth_mode=dev_header is only allowed"):
        Settings(environment=environment, patient_auth_mode="dev_header")


def test_the_app_refuses_to_start_when_the_environment_turns_it_on(
        monkeypatch: pytest.MonkeyPatch) -> None:
    from app.main import create_app

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("PATIENT_AUTH_MODE", "dev_header")
    with pytest.raises(ValidationError, match="patient_auth_mode=dev_header"):
        create_app(Settings())


def test_a_patient_reaches_their_own_record(dev: TestClient) -> None:
    assert dev.get(f"/me/appointments/{MINE}", headers=_headers()).status_code == 200


def test_another_patients_record_is_not_found_like_a_missing_one(dev: TestClient) -> None:
    theirs = dev.get(f"/me/appointments/{THEIRS}", headers=_headers())
    missing = dev.get(f"/me/appointments/{uuid4()}", headers=_headers())
    assert theirs.status_code == missing.status_code == 404
    assert theirs.json()["code"] == missing.json()["code"] == "not-found"
    # The other patient, signed in themself, does see it.
    assert dev.get(f"/me/appointments/{THEIRS}",
                   headers=_headers(OTHER_PATIENT)).status_code == 200


def test_a_patient_session_opens_no_staff_endpoint(dev: TestClient) -> None:
    """PAT holds no staff permission (D84): portal headers never stand in for a staff user."""
    r = dev.get("/staff-only", headers=_headers())
    assert r.status_code == 401
    assert dev.get("/staff-only", headers={**_headers(), DEV_USER_HEADER: "md"}).status_code == 200


def test_require_own_record_refuses_none() -> None:
    from app.core.errors import NotFound

    patient = PortalPatient(patient_id=PATIENT, organization_id=CLINIC)
    require_own_record(patient, PATIENT)
    for owner in (OTHER_PATIENT, None):
        with pytest.raises(NotFound):
            require_own_record(patient, owner)
