"""publish(), the event stream and operations against the real schema, as shri_app (forced RLS).

Needs TEST_DATABASE_URL, migrated to head; skipped otherwise. Streams are made short
(STREAM_MAX_SECONDS) so a test reads one whole stream. Synthetic data only.
"""

import json
from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core import events, long_running
from app.core.config import Settings
from app.core.deps import CurrentUser, current_user
from app.core.long_running import create_operation, finish_operation, problem_body
from app.core.routing import API_PREFIX
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


@pytest.fixture(autouse=True)
def short_streams(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(events, "STREAM_MAX_SECONDS", 1.0)
    monkeypatch.setattr(events, "POLL_SECONDS", 0.1)


@pytest.fixture
def clinic(db: Session, tenant: UUID, admin_engine: Engine,  # noqa: F811
           app_engine: Engine) -> dict[str, Any]:  # noqa: F811
    desk = b.practitioner(db, "Rivera", "Elena")["user"]
    colleague = b.practitioner(db, "Okafor", "Ada")["user"]
    patient = b.patient(db)
    db.commit()
    other_tenant = make_tenant(admin_engine)
    other_db = open_session(app_engine, other_tenant)
    stranger_id = b.practitioner(other_db, "Lund", "Sami")["user"].id
    other_db.commit()
    other_db.close()
    return {"tenant": tenant, "patient": patient.id,
            "desk": CurrentUser(id=desk.id, organization_id=tenant, roles=frozenset({"FD"})),
            "colleague": CurrentUser(id=colleague.id, organization_id=tenant,
                                     roles=frozenset({"FD"})),
            "stranger": CurrentUser(id=stranger_id, organization_id=other_tenant,
                                    roles=frozenset({"FD"}))}


class Signed:
    user: CurrentUser


@pytest.fixture
def client(clinic: dict[str, Any]) -> Iterator[tuple[TestClient, Signed]]:
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    signed = Signed()
    signed.user = clinic["desk"]
    app.dependency_overrides[current_user] = lambda: signed.user
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c, signed


def _run(client: TestClient, user: CurrentUser, work: Callable[[Any], Any]) -> Any:
    async def call() -> Any:
        database = client.app.state.db  # type: ignore[attr-defined]
        async with database.tenant_session(user.organization_id, user.id) as session:
            result = await work(session)
            await session.commit()
            return result

    assert client.portal is not None
    return client.portal.call(call)


def _publish(client: TestClient, user: CurrentUser, type_: str, subject: str,
             data: dict[str, Any] | None = None, **columns: Any) -> UUID:
    async def work(session: Any) -> UUID:
        return await events.publish(session, type_, subject, data, **columns)

    result: UUID = _run(client, user, work)
    return result


def _stream(client: TestClient, last_event_id: str | None = None) -> list[dict[str, Any]]:
    headers = {"Last-Event-ID": last_event_id} if last_event_id else {}
    response = client.get(f"{API_PREFIX}/events/stream", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text.startswith("retry: 5000\n\n")
    return [json.loads(line[len("data: "):]) for line in response.text.splitlines()
            if line.startswith("data: ")]


# ------------------------------------------------------------------------------------ publish
def test_an_event_commits_with_the_change_or_not_at_all(
        client: tuple[TestClient, Signed], clinic: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    c, _ = client
    subject = f"appointment/{uuid4()}"

    async def rolled_back(session: Any) -> None:
        await events.publish(session, "appointment.booked", subject)
        await session.rollback()

    _run(c, clinic["desk"], rolled_back)
    kept = _publish(c, clinic["desk"], "appointment.booked", subject, {"status": "booked"})
    with admin_engine.connect() as conn:
        rows = conn.execute(text("SELECT id FROM admin.event_log WHERE subject = :s"),
                            {"s": subject}).scalars().all()
    assert rows == [kept]


# ------------------------------------------------------------------------------------- stream
def test_replay_sends_what_the_user_may_see_since_the_last_event(
        client: tuple[TestClient, Signed], clinic: dict[str, Any]) -> None:
    c, signed = client
    desk, colleague = clinic["desk"], clinic["colleague"]
    marker = _publish(c, desk, "appointment.booked", f"appointment/{uuid4()}")
    booked = _publish(c, desk, "appointment.checked-in", f"appointment/{uuid4()}",
                      {"status": "arrived"})
    _publish(c, desk, "break-glass.granted", f"patient/{clinic['patient']}")  # internal only
    mine = _publish(c, desk, "operation.completed", f"operation/{uuid4()}",
                    {"kind": "file.scan", "status": "succeeded"}, target_user_id=desk.id)
    _publish(c, desk, "operation.completed", f"operation/{uuid4()}",
             {"kind": "file.scan", "status": "succeeded"}, target_user_id=colleague.id)

    received = _stream(c, str(marker))
    assert [e["id"] for e in received] == [str(booked), str(mine)]
    assert received[0]["data"] == {"status": "arrived"}
    assert received[0]["source"] == "/scheduling"

    signed.user = colleague  # the colleague gets only their own operation, not the desk's
    assert [e["type"] for e in _stream(c, str(marker))] == ["appointment.checked-in",
                                                            "operation.completed"]


def test_another_clinics_events_never_arrive(
        client: tuple[TestClient, Signed], clinic: dict[str, Any]) -> None:
    c, signed = client
    marker = _publish(c, clinic["stranger"], "appointment.booked", f"appointment/{uuid4()}")
    _publish(c, clinic["desk"], "appointment.booked", f"appointment/{uuid4()}")
    signed.user = clinic["stranger"]
    assert _stream(c, str(marker)) == []


def test_a_restricted_patients_event_loses_its_data(
        client: tuple[TestClient, Signed], clinic: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    c, _ = client
    with admin_engine.begin() as conn:
        conn.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R']::varchar[] "
                          "WHERE id = :p"), {"p": clinic["patient"]})
    marker = _publish(c, clinic["desk"], "appointment.booked", f"appointment/{uuid4()}")
    _publish(c, clinic["desk"], "appointment.checked-in", f"appointment/{uuid4()}",
             {"status": "arrived", "encounterId": str(uuid4())}, patient_id=clinic["patient"])
    (event,) = _stream(c, str(marker))
    assert event["type"] == "appointment.checked-in" and event["data"] == {}


def test_a_gap_too_old_to_replay_sends_stream_reset(client: tuple[TestClient, Signed]) -> None:
    c, _ = client
    (event,) = _stream(c, str(uuid4()))  # an event this server doesn't have
    assert event["type"] == "stream.reset"
    assert _stream(c) == []  # without Last-Event-ID: new events only


def test_at_most_five_streams_per_user(client: tuple[TestClient, Signed],
                                       clinic: dict[str, Any],
                                       monkeypatch: pytest.MonkeyPatch) -> None:
    c, _ = client
    monkeypatch.setitem(events._open_streams, clinic["desk"].id, 5)
    refused = c.get(f"{API_PREFIX}/events/stream")
    assert refused.status_code == 429 and refused.json()["code"] == "rate-limited"


def test_the_stream_needs_a_signed_in_user(client: tuple[TestClient, Signed]) -> None:
    c, _ = client
    c.app.dependency_overrides.clear()  # type: ignore[attr-defined]
    assert c.get(f"{API_PREFIX}/events/stream").status_code == 401


# ------------------------------------------------------------------------------- operations
def _create(c: TestClient, user: CurrentUser, kind: str = "ai.chart-summary") -> UUID:
    async def work(session: Any) -> UUID:
        return (await create_operation(session, kind)).id

    result: UUID = _run(c, user, work)
    return result


def test_the_creator_reads_their_operation_with_retry_after(
        client: tuple[TestClient, Signed], clinic: dict[str, Any]) -> None:
    c, _ = client
    operation_id = _create(c, clinic["desk"], "eligibility.check")
    response = c.get(f"{API_PREFIX}/operations/{operation_id}")
    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["kind"], body["status"]) == (str(operation_id),
                                                          "eligibility.check", "queued")
    assert response.headers["Retry-After"] == "2" and response.headers["ETag"].startswith('"')
    assert "result" not in body and "completedAt" not in body


@pytest.mark.parametrize("who", ["colleague", "stranger"])
def test_anyone_else_gets_404(client: tuple[TestClient, Signed], clinic: dict[str, Any],
                              who: str) -> None:
    c, signed = client
    operation_id = _create(c, clinic["desk"])
    signed.user = clinic[who]
    for response in (c.get(f"{API_PREFIX}/operations/{operation_id}"),
                     c.post(f"{API_PREFIX}/operations/{operation_id}/cancel")):
        assert response.status_code == 404 and response.json()["code"] == "not-found"


def test_a_malformed_id_is_422_and_no_user_is_401(client: tuple[TestClient, Signed]) -> None:
    c, _ = client
    assert c.get(f"{API_PREFIX}/operations/not-a-uuid").status_code == 422
    c.app.dependency_overrides.clear()  # type: ignore[attr-defined]
    assert c.get(f"{API_PREFIX}/operations/{uuid4()}").status_code == 401


def test_finishing_tells_the_creator_and_names_the_result(
        client: tuple[TestClient, Signed], clinic: dict[str, Any]) -> None:
    c, _ = client
    desk = clinic["desk"]
    marker = _publish(c, desk, "appointment.booked", f"appointment/{uuid4()}")
    operation_id = _create(c, desk, "eligibility.check")
    check_id = uuid4()

    async def finish(session: Any) -> None:
        await finish_operation(session, operation_id, "succeeded",
                               result=("eligibility-check", check_id))

    _run(c, desk, finish)
    response = c.get(f"{API_PREFIX}/operations/{operation_id}")
    body = response.json()
    assert body["status"] == "succeeded" and "completedAt" in body
    assert body["result"] == {"type": "eligibility-check", "id": str(check_id)}
    assert "Retry-After" not in response.headers
    (event,) = _stream(c, str(marker))
    assert event["type"] == "operation.completed"
    assert event["data"] == {"kind": "eligibility.check", "status": "succeeded",
                             "resultType": "eligibility-check", "resultId": str(check_id)}
    refused = c.post(f"{API_PREFIX}/operations/{operation_id}/cancel")
    assert refused.status_code == 409 and refused.json()["currentState"] == "succeeded"


def test_an_ai_operation_can_be_cancelled_once_and_then_stays_cancelled(
        client: tuple[TestClient, Signed], clinic: dict[str, Any]) -> None:
    c, _ = client
    operation_id = _create(c, clinic["desk"], "ai.transcription")
    first = c.post(f"{API_PREFIX}/operations/{operation_id}/cancel")
    assert first.status_code == 200 and first.json()["status"] == "cancelled"
    again = c.post(f"{API_PREFIX}/operations/{operation_id}/cancel")
    assert again.status_code == 200 and again.json() == first.json()


def test_other_kinds_cannot_be_cancelled(client: tuple[TestClient, Signed],
                                         clinic: dict[str, Any]) -> None:
    c, _ = client
    operation_id = _create(c, clinic["desk"], "eligibility.check")
    refused = c.post(f"{API_PREFIX}/operations/{operation_id}/cancel")
    assert refused.status_code == 409
    assert refused.json()["code"] == "invalid-state-transition"
    assert refused.json()["currentState"] == "queued"


def test_work_that_ran_too_long_is_marked_failed_when_read(
        client: tuple[TestClient, Signed], clinic: dict[str, Any],
        admin_engine: Engine) -> None:  # noqa: F811
    c, _ = client
    operation_id = _create(c, clinic["desk"], "eligibility.check")
    with admin_engine.begin() as conn:
        conn.execute(text("UPDATE admin.operation SET created_at = now() - interval '1 hour' "
                          "WHERE id = :i"), {"i": operation_id})
    body = c.get(f"{API_PREFIX}/operations/{operation_id}").json()
    assert body["status"] == "failed"
    assert body["error"]["code"] == "upstream-timeout" and body["error"]["status"] == 504


def test_finish_rules(client: tuple[TestClient, Signed], clinic: dict[str, Any]) -> None:
    c, _ = client
    operation_id = _create(c, clinic["desk"])

    async def fail_without_problem(session: Any) -> None:
        await finish_operation(session, operation_id, "failed")

    with pytest.raises(ValueError, match="needs its Problem"):
        _run(c, clinic["desk"], fail_without_problem)

    async def fail(session: Any) -> None:
        await finish_operation(session, operation_id, "failed",
                               error=problem_body("upstream-error"))

    _run(c, clinic["desk"], fail)
    assert c.get(f"{API_PREFIX}/operations/{operation_id}").json()["error"]["code"] == (
        "upstream-error")
    assert long_running.FINAL >= {"failed"}
