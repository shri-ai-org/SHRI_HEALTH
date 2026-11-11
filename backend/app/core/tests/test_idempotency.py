"""Idempotency-Key rules that need no database: the key's format, the fingerprint and the startup
check. The full flow is in test_idempotency_postgres.py."""

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import APIRouter, Depends, FastAPI

from app.core.deps import portal_db, portal_session, public_db, require, tenant_db
from app.core.errors import ServiceUnavailable, ValidationFailed
from app.core.idempotency import (
    IN_PROGRESS_LEASE,
    RETENTION,
    Claim,
    PortalKeys,
    fingerprint,
    parse_key,
)
from app.core.operations import OPERATIONS_PATH_ENV, operations_file, route_problems
from app.core.routing import API_PREFIX

ATTEMPT = str(uuid4())  # made at run time: no key-like literal in the source


@pytest.mark.parametrize("raw", [ATTEMPT, f'"{ATTEMPT}"', f"  {ATTEMPT.upper()} ",
                                 f'"{ATTEMPT.upper()}"'])
def test_a_uuid_is_accepted_bare_or_quoted(raw: str) -> None:
    assert parse_key(raw) == ATTEMPT


@pytest.mark.parametrize("raw", ["", '""', "abc", ATTEMPT[:-1], f"{{{ATTEMPT}}}",
                                 f"urn:uuid:{ATTEMPT}", ATTEMPT.replace("-", ""), f'"{ATTEMPT}',
                                 f"{ATTEMPT}, {ATTEMPT}"])
def test_anything_else_is_a_field_error_naming_the_header(raw: str) -> None:
    with pytest.raises(ValidationFailed) as refused:
        parse_key(raw)
    assert refused.value.code == "validation-failed"
    assert refused.value.extensions["errors"] == [
        {"in": "header", "name": "Idempotency-Key", "code": "invalid-format"}]


def test_the_fingerprint_ignores_json_key_order_and_spacing() -> None:
    a = fingerprint(b'{"name": "Synthetic Clinic", "beds": 2, "tags": ["a", "b"]}')
    b = fingerprint(b'{"tags":["a","b"],"beds":2,\n "name":"Synthetic Clinic"}')
    assert a == b and len(a) == 64
    assert a != fingerprint(b'{"name": "Synthetic Clinic", "beds": 3, "tags": ["a", "b"]}')
    assert a != fingerprint(b'{"name": "Synthetic Clinic", "beds": 2, "tags": ["b", "a"]}')


def test_a_body_that_isnt_json_is_hashed_as_sent() -> None:
    assert fingerprint(b"") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    assert fingerprint(b"\xff\xfe") != fingerprint(b"\xff\xfd")


# The startup check: an operation with x-idempotency needs tenant_db, which claims the key.


@pytest.fixture
def use_ops(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Callable[[dict[str, Any]], None]:
    def _use(extra: dict[str, Any]) -> None:
        current = json.loads(operations_file().read_text(encoding="utf-8"))
        current["operations"].update(extra)
        path = tmp_path / "operations.json"
        path.write_text(json.dumps(current), encoding="utf-8")
        monkeypatch.setenv(OPERATIONS_PATH_ENV, str(path))

    return _use


async def _endpoint() -> None:
    return None


def _app(operation_id: str, path: str, dependencies: list[Any]) -> FastAPI:
    router = APIRouter()
    router.add_api_route(path, _endpoint, methods=["POST"], operation_id=operation_id,
                         dependencies=dependencies)
    app = FastAPI()
    app.include_router(router, prefix=API_PREFIX)
    return app


def _op(permission: str, audit: dict[str, Any]) -> dict[str, Any]:
    return {"testRetry": {"method": "POST", "path": f"{API_PREFIX}/test-retries",
                          "permission": permission, "audit": audit, "idempotency": "supported"}}


UNAUDITED = {"action": "C", "category": "none"}


def test_an_idempotent_operation_needs_tenant_db(use_ops: Callable[[dict[str, Any]], None]) -> None:
    use_ops(_op("patients:read", UNAUDITED))  # unaudited, so only the key needs tenant_db
    read = Depends(require("patients:read"))
    problems = route_problems(_app("testRetry", "/test-retries", [read]))
    assert problems == [f"POST {API_PREFIX}/test-retries: testRetry has x-idempotency, so it "
                        "needs Depends(tenant_db), which claims the key"]
    assert route_problems(_app("testRetry", "/test-retries", [read, Depends(tenant_db)])) == []


@pytest.mark.parametrize(("permission", "audit", "dependencies"), [
    ("public", {"action": "C", "category": "phi-write", "actor": "anonymous"}, [public_db]),
    ("public", {"action": "C", "category": "security", "actor": "patient"}, []),
    ("partner-signed", {"action": "C", "category": "none", "actor": "partner"}, []),
])
def test_idempotency_outside_staff_and_portal_sessions_is_refused_until_core_builds_it(
        use_ops: Callable[[dict[str, Any]], None], permission: str, audit: dict[str, Any],
        dependencies: list[Any]) -> None:
    use_ops(_op(permission, audit))
    problems = route_problems(_app("testRetry", "/test-retries",
                                   [Depends(d) for d in dependencies]))
    assert any("core handles only for staff and portal sessions so far" in p
               for p in problems), problems


PORTAL_WRITE = {"action": "C", "category": "phi-write", "patient": "session", "actor": "patient"}


def test_an_idempotent_portal_write_needs_portal_db(
        use_ops: Callable[[dict[str, Any]], None]) -> None:
    """portal_db claims the key, keyed by the session's clinic and patient (claim_portal)."""
    use_ops(_op("public", PORTAL_WRITE))
    problems = route_problems(_app("testRetry", "/test-retries", [Depends(portal_session)]))
    assert (f"POST {API_PREFIX}/test-retries: testRetry has x-idempotency, so it needs "
            "Depends(portal_db), which claims the key") in problems
    assert route_problems(_app("testRetry", "/test-retries",
                               [Depends(portal_session), Depends(portal_db)])) == []


# The portal's keys in memory (PortalKeys): what portal_db's claim relies on.

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)
KEY = ("clinic", "patient", "POST", "/api/v1/portal/me/appointments", ATTEMPT)


def _claim(keys: PortalKeys, key: tuple[Any, ...] = KEY, now: datetime = NOW) -> Claim:
    held, claimed = keys.find_or_claim(key, "a" * 64, now)
    assert claimed
    return Claim(held.record_id, uuid4(), uuid4(), held.expires_at, memory_key=key)


def test_a_finished_key_is_kept_for_the_retention_then_claimed_again() -> None:
    keys = PortalKeys()
    claim = _claim(keys)
    keys.finish(claim, 201, {"content-type": "application/json"}, b"{}", NOW)
    held, claimed = keys.find_or_claim(KEY, "a" * 64, NOW + RETENTION - timedelta(seconds=1))
    assert not claimed and (held.status, held.body) == (201, b"{}")
    _, claimed = keys.find_or_claim(KEY, "a" * 64, NOW + RETENTION)
    assert claimed


def test_a_claim_whose_lease_ran_out_is_taken_over_and_the_old_one_cant_finish() -> None:
    keys = PortalKeys()
    old = _claim(keys)
    new = _claim(keys, now=NOW + IN_PROGRESS_LEASE)
    keys.finish(old, 201, {}, b"old", NOW + IN_PROGRESS_LEASE)  # not its claim any more
    keys.release(old)
    held, claimed = keys.find_or_claim(KEY, "a" * 64, NOW + IN_PROGRESS_LEASE)
    assert not claimed and held.record_id == new.record_id and held.status is None


def test_a_released_key_can_be_claimed_again_at_once() -> None:
    keys = PortalKeys()
    keys.release(_claim(keys))
    assert len(keys) == 0
    _claim(keys)


def test_beyond_max_live_keys_a_new_one_is_refused_but_expired_ones_make_room(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(PortalKeys, "MAX", 2)
    keys = PortalKeys()
    _claim(keys, key=(*KEY[:-1], "1"))
    _claim(keys, key=(*KEY[:-1], "2"))
    with pytest.raises(ServiceUnavailable):
        keys.find_or_claim((*KEY[:-1], "3"), "a" * 64, NOW)
    _claim(keys, key=(*KEY[:-1], "3"), now=NOW + IN_PROGRESS_LEASE)  # the two have expired
    assert len(keys) == 1


def test_the_contracts_idempotent_staff_operations_are_all_post() -> None:
    """The table only takes POST, PUT and PATCH; today's contract uses POST only."""
    current = json.loads(operations_file().read_text(encoding="utf-8"))["operations"]
    methods = {item["method"] for item in current.values() if item.get("idempotency")}
    assert methods == {"POST"}
