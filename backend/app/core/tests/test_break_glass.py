"""POST /patients/{patientId}/break-glass without a database: who may call it, and the body."""

from collections.abc import Callable
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.deps import DEV_USER_HEADER

URL = f"/api/v1/patients/{uuid4()}/break-glass"


def test_unauthenticated_is_401(make_app: Callable[..., FastAPI]) -> None:
    client = TestClient(make_app(), raise_server_exceptions=False)

    response = client.post(URL, json={"reasonCode": "emergency-care"})

    assert response.status_code == 401
    assert response.json()["code"] == "unauthenticated"


def test_a_role_without_break_glass_is_403(make_app: Callable[..., FastAPI]) -> None:
    client = TestClient(make_app(), raise_server_exceptions=False)

    for role in ("fd", "bil", "dsp", "none"):
        response = client.post(URL, json={"reasonCode": "emergency-care"},
                               headers={DEV_USER_HEADER: role})
        assert response.status_code == 403, role
        assert response.json()["code"] == "permission-denied"
