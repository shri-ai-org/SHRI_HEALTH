from collections.abc import Callable
from typing import Any
from uuid import UUID

import pytest
from fastapi import APIRouter, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field

from app.core.errors import (
    CATALOGUE,
    RESERVED_MEMBERS,
    AppError,
    Conflict,
    Forbidden,
    NotFound,
    ValidationFailed,
    field_error,
    problem,
)

TYPE_BASE = "tag:company-domain.invalid,2026:problem/"


class Name(BaseModel):
    model_config = ConfigDict(extra="forbid")
    family: str = Field(max_length=5)


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")
    birth_year: int = Field(ge=1900)
    name: Name


def _client(make_app: Callable[..., FastAPI]) -> TestClient:
    router = APIRouter()

    @router.get("/raise/{kind}")
    async def raise_error(kind: str) -> None:
        errors: dict[str, AppError] = {
            "not-found": NotFound(),
            "booking": Conflict(code="booking-conflict"),
            "merged": Conflict(code="patient-merged", mergedIntoId="m-1"),
            "forbidden": Forbidden(),
            "rule": ValidationFailed(
                "Birth year is in the future.",
                code="business-rule-violation",
                errors=[field_error("body", "/birthYear", "out-of-range")],
            ),
        }
        raise errors[kind]

    @router.get("/crash")
    async def crash() -> None:
        raise RuntimeError("secret internal detail")

    @router.post("/echo")
    async def echo(body: Body) -> Body:
        return body

    @router.get("/items/{item_id}")
    async def item(item_id: int, limit: int = 25) -> None:
        return None

    app = make_app()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    ("kind", "status", "code"),
    [
        ("not-found", 404, "not-found"),
        ("booking", 409, "booking-conflict"),
        ("forbidden", 403, "permission-denied"),
        ("rule", 422, "business-rule-violation"),
    ],
)
def test_app_errors_use_the_problem_shape(
    make_app: Callable[..., FastAPI], kind: str, status: int, code: str
) -> None:
    response = _client(make_app).get(f"/raise/{kind}")

    assert response.status_code == status
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["type"] == TYPE_BASE + code
    assert body["title"] == CATALOGUE[code].title
    assert body["status"] == status
    assert body["code"] == code
    assert body["instance"] == f"/raise/{kind}"
    assert body["requestId"] == response.headers["X-Request-ID"]


def test_extensions_are_included(make_app: Callable[..., FastAPI]) -> None:
    body = _client(make_app).get("/raise/merged").json()
    assert body["mergedIntoId"] == "m-1"


def test_business_rule_errors_list_fields(make_app: Callable[..., FastAPI]) -> None:
    body = _client(make_app).get("/raise/rule").json()
    assert body["errors"] == [{"in": "body", "pointer": "/birthYear", "code": "out-of-range"}]


def test_validation_errors_replace_fastapi_default(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).post(
        "/echo",
        json={"birth_year": 1850, "name": {"family": "SECRETNAME"}, "ssn": "999-00-1234"},
    )

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation-failed"
    assert body["detail"] == "3 fields are invalid."
    assert sorted(body["errors"], key=lambda e: e["pointer"]) == [
        {"in": "body", "pointer": "/birth_year", "code": "out-of-range"},
        {"in": "body", "pointer": "/name/family", "code": "too-long"},
        {"in": "body", "pointer": "/ssn", "code": "unknown-field"},
    ]
    assert "SECRETNAME" not in response.text
    assert "999-00-1234" not in response.text
    assert "detail" not in body["errors"][0]


def test_missing_and_wrongly_typed_fields(make_app: Callable[..., FastAPI]) -> None:
    body = _client(make_app).post("/echo", json={"birth_year": "abc"}).json()
    assert sorted(body["errors"], key=lambda e: e["pointer"]) == [
        {"in": "body", "pointer": "/birth_year", "code": "invalid-type"},
        {"in": "body", "pointer": "/name", "code": "required"},
    ]


def test_query_and_path_errors_name_the_parameter(make_app: Callable[..., FastAPI]) -> None:
    body = _client(make_app).get("/items/x?limit=y").json()
    assert sorted(body["errors"], key=lambda e: e["in"]) == [
        {"in": "path", "name": "item_id", "code": "invalid-type"},
        {"in": "query", "name": "limit", "code": "invalid-type"},
    ]


def test_invalid_json_is_malformed_request(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).post(
        "/echo", content=b'{"birth_year": 19', headers={"content-type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json()["code"] == "malformed-request"


def test_unhandled_errors_hide_details(make_app: Callable[..., FastAPI]) -> None:
    response = _client(make_app).get("/crash")

    assert response.status_code == 500
    body = response.json()
    assert body["code"] == "internal-error"
    assert "secret" not in response.text
    assert body["requestId"] == response.headers["X-Request-ID"]


@pytest.mark.parametrize(
    ("method", "path", "status", "code"),
    [("GET", "/api/v1/nothing-here", 404, "not-found"), ("DELETE", "/echo", 405,
                                                         "method-not-allowed")],
)
def test_framework_errors_are_problems(
    make_app: Callable[..., FastAPI], method: str, path: str, status: int, code: str
) -> None:
    response = _client(make_app).request(method, path)

    assert response.status_code == status
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == code


def test_problem_type_base_comes_from_settings(make_app: Callable[..., FastAPI]) -> None:
    app = make_app(problem_type_base="tag:example.com,2026:problem/")
    body = TestClient(app).get("/api/v1/nothing-here").json()
    assert body["type"] == "tag:example.com,2026:problem/not-found"


def test_code_must_match_the_error_class() -> None:
    with pytest.raises(ValueError, match="needs a 409 code"):
        Conflict(code="not-found")
    with pytest.raises(ValueError, match="Unknown problem code"):
        NotFound(code="no-such-code")


def test_field_error_codes_are_checked() -> None:
    assert field_error("query", "limit", "out-of-range") == {
        "in": "query", "name": "limit", "code": "out-of-range"
    }
    with pytest.raises(ValueError):
        field_error("body", "/x", "bad-code")

# Titles from the contract's examples (contracts/openapi/components/examples/Problem*.yaml).
CONTRACT_TITLES = {
    "unauthenticated": "Not signed in",
    "permission-denied": "Permission denied",
    "break-glass-required": "Restricted chart",
    "not-found": "Not found",
    "invalid-state-transition": "Action not allowed in the current state",
    "record-locked": "Record is locked",
    "possible-duplicate": "Possible duplicate patient",
    "precondition-failed": "Record changed",
    "precondition-required": "If-Match required",
    "rate-limited": "Too many requests",
    "validation-failed": "Request validation failed",
    "malformed-request": "Malformed request",
    "internal-error": "Internal error",
}


@pytest.mark.parametrize(("code", "title"), sorted(CONTRACT_TITLES.items()))
def test_titles_match_the_contract(code: str, title: str) -> None:
    assert CATALOGUE[code].title == title


def test_cookie_location_is_never_reported() -> None:
    from app.core.errors import _to_field_error

    assert _to_field_error({"loc": ("cookie", "x"), "type": "missing"})["in"] != "cookie"


# `code` and `detail` are real arguments of every error class, so only these can sneak in as
# extensions.
@pytest.mark.parametrize("member", sorted(RESERVED_MEMBERS - {"code", "detail"}))
def test_extensions_cannot_set_standard_members(member: str) -> None:
    extensions: dict[str, Any] = {member: "x"}
    with pytest.raises(ValueError, match="standard Problem members"):
        Conflict(code="patient-merged", **extensions)


def test_problem_never_lets_extensions_overwrite_standard_members(
    make_app: Callable[..., FastAPI],
) -> None:
    router = APIRouter()

    @router.get("/sneaky")
    async def sneaky(request: Request) -> JSONResponse:
        return problem(request, "not-found", status=200, requestId="x", title="Fine",
                       type="about:blank", mergedIntoId="m-1")

    app = make_app()
    app.include_router(router)
    response = TestClient(app).get("/sneaky")
    body = response.json()

    assert response.status_code == 404
    assert (body["code"], body["status"], body["type"], body["title"]) == (
        "not-found", 404, TYPE_BASE + "not-found", "Not found")
    assert body["requestId"] == response.headers["X-Request-ID"]
    assert body["mergedIntoId"] == "m-1"  # ordinary extensions still pass through


def _idempotent_client(make_app: Callable[..., FastAPI]) -> TestClient:
    router = APIRouter()

    @router.post("/checks")
    async def create_check(
        key: UUID = Header(alias="Idempotency-Key"),
    ) -> dict[str, str]:
        return {"key": str(key)}

    app = make_app()
    app.include_router(router)
    return TestClient(app)


def test_missing_idempotency_key_is_400(make_app: Callable[..., FastAPI]) -> None:
    response = _idempotent_client(make_app).post("/checks")

    assert response.status_code == 400
    assert response.json()["code"] == "idempotency-key-missing"


def test_malformed_idempotency_key_is_422_naming_the_header(
    make_app: Callable[..., FastAPI],
) -> None:
    response = _idempotent_client(make_app).post("/checks", headers={"Idempotency-Key": "nope"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation-failed"
    assert body["errors"] == [{"in": "header", "name": "Idempotency-Key", "code": "invalid-format"}]
    assert "nope" not in response.text


def test_valid_idempotency_key_passes(make_app: Callable[..., FastAPI]) -> None:
    key = "0b7e4b0c-3f4e-4d3a-9d0e-0c1b5e2f9a11"
    response = _idempotent_client(make_app).post("/checks", headers={"Idempotency-Key": key})

    assert response.json() == {"key": key}


def test_405_keeps_the_allow_header(client: TestClient) -> None:
    response = client.delete("/health")

    assert response.status_code == 405
    assert response.json()["code"] == "method-not-allowed"
    assert response.headers["Allow"] == "GET"

