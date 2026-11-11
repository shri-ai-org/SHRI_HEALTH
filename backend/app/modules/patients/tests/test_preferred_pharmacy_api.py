"""setPreferredPharmacy (D50, inventory #43) with the fakes: success, If-Match, permission,
validation, the restricted-chart check and a merged chart. Synthetic data only."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi.testclient import TestClient

from app.core.deps import DEV_USERS

from .conftest import new_patient
from .fakes import World

Client = Callable[[str], TestClient]


def _patient(as_user: Client) -> str:
    created = as_user("fd").post("/api/v1/patients", json=new_patient())
    assert created.status_code == 201, created.text
    patient_id: str = created.json()["id"]
    return patient_id


def _pharmacy(world: World, *, active: bool = True) -> str:
    pharmacy = uuid.uuid4()
    world.pharmacies[pharmacy] = ("Test Pharmacy 12", active)
    return str(pharmacy)


def _put(as_user: Client, who: str, patient_id: str, body: Any, if_match: str | None = '"1"'
         ) -> Any:
    headers = {"If-Match": if_match} if if_match is not None else {}
    return as_user(who).put(f"/api/v1/patients/{patient_id}/preferred-pharmacy", json=body,
                            headers=headers)


def _record(world: World, patient_id: str) -> Any:
    return next(iter(world.patients.values()))[UUID(patient_id)]


def test_set_returns_the_pharmacy_and_the_patients_new_etag(as_user: Client, world: World
                                                           ) -> None:
    patient_id, pharmacy = _patient(as_user), _pharmacy(world)
    done = _put(as_user, "fd", patient_id, {"pharmacyId": pharmacy})
    assert done.status_code == 200, done.text
    assert done.headers["ETag"] == '"2"'
    assert done.json() == {"patientId": patient_id, "pharmacyId": pharmacy,
                           "name": "Test Pharmacy 12", "ncpdpId": "0000012",
                           "city": "Springfield", "state": "IL",
                           "updatedAt": done.json()["updatedAt"]}
    again = _put(as_user, "adm", patient_id, {"pharmacyId": pharmacy}, '"2"')
    assert again.status_code == 200 and again.headers["ETag"] == '"2"'  # the same: no change


def test_set_needs_patients_update(as_user: Client, world: World) -> None:
    patient_id, pharmacy = _patient(as_user), _pharmacy(world)
    for who in ("ma", "md", "bil"):
        refused = _put(as_user, who, patient_id, {"pharmacyId": pharmacy})
        assert refused.status_code == 403 and refused.json()["code"] == "permission-denied", who
    assert _record(world, patient_id).pharmacy_id is None


def test_set_needs_a_current_if_match(as_user: Client, world: World) -> None:
    patient_id, pharmacy = _patient(as_user), _pharmacy(world)
    missing = _put(as_user, "fd", patient_id, {"pharmacyId": pharmacy}, None)
    assert missing.status_code == 428 and missing.json()["code"] == "precondition-required"
    stale = _put(as_user, "fd", patient_id, {"pharmacyId": pharmacy}, '"7"')
    assert stale.status_code == 412 and stale.headers["ETag"] == '"1"'
    weak = _put(as_user, "fd", patient_id, {"pharmacyId": pharmacy}, 'W/"1"')
    assert weak.status_code == 412


def test_set_validates_the_body_and_the_pharmacy(as_user: Client, world: World) -> None:
    patient_id = _patient(as_user)
    for body in ({}, {"pharmacyId": "not-a-uuid"},
                 {"pharmacyId": _pharmacy(world), "note": "x"}):
        refused = _put(as_user, "fd", patient_id, body)
        assert refused.status_code == 422 and refused.json()["code"] == "validation-failed", body
    unknown = _put(as_user, "fd", patient_id, {"pharmacyId": str(uuid.uuid4())})
    assert unknown.status_code == 404 and unknown.json()["code"] == "not-found"
    inactive = _put(as_user, "fd", patient_id, {"pharmacyId": _pharmacy(world, active=False)})
    assert inactive.status_code == 422
    assert inactive.json()["code"] == "business-rule-violation"
    assert inactive.json()["errors"][0]["pointer"] == "/pharmacyId"
    assert _record(world, patient_id).pharmacy_id is None


def test_another_clinics_patient_is_not_found(as_user: Client, world: World) -> None:
    patient_id, pharmacy = _patient(as_user), _pharmacy(world)
    other = _put(as_user, "md-b", patient_id, {"pharmacyId": pharmacy})
    assert other.status_code in (403, 404)
    assert _put(as_user, "fd", str(uuid.uuid4()), {"pharmacyId": pharmacy}).status_code == 404


def test_a_restricted_chart_needs_break_glass(as_user: Client, world: World) -> None:
    patient_id, pharmacy = _patient(as_user), _pharmacy(world)
    _record(world, patient_id).labels.add("R")
    refused = _put(as_user, "fd", patient_id, {"pharmacyId": pharmacy})
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    world.grants.add((DEV_USERS["fd"].id, UUID(patient_id)))
    assert _put(as_user, "fd", patient_id, {"pharmacyId": pharmacy}).status_code == 200


def test_a_merged_patient_is_refused(as_user: Client, world: World) -> None:
    patient_id, pharmacy = _patient(as_user), _pharmacy(world)
    _record(world, patient_id).merged_into_id = uuid.uuid4()
    refused = _put(as_user, "fd", patient_id, {"pharmacyId": pharmacy})
    assert refused.status_code == 409 and refused.json()["code"] == "patient-merged"
