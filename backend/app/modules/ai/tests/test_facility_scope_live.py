"""The facility-scope sweep (SECURITY_MODEL §5.1, D37) for the AI's morning brief and differential
(D116): a visit at another facility of the clinic, or in another clinic, is 404 and nothing
changes; a brief or differential is its requester's only; a brief lists only appointments at the
user's own facilities. The other AI operations check their scope in their own live tests.
Synthetic data only."""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.facility_scope import (
    API,
    Row,
    appointment_today,
    failures,
    report,
    staff,
    sweep,
)
from app.modules.scheduling.tests.test_check_in_live import _check_in, _sql

from .stub_claude_server import StubClaudeServer
from .test_ai02_live import _summary_on
from .test_brief_differential_live import _today

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

COVERED = {"createDifferential", "getDifferential", "createMorningBrief", "getMorningBrief"}


def _visit(client: Any, practice: Practice, *, at_a2: bool, front_desk: str) -> str:
    p = practice
    appointment = appointment_today(
        p, "kaia", facility=p.other_facility if at_a2 else p.facility,
        provider=p.other_provider if at_a2 else p.provider, hour=14 if at_a2 else 11,
        room=None if at_a2 else p.room)
    done = _check_in(client, appointment, user=front_desk, selfPay=True)
    assert done.status_code == 200, done.text
    encounter: str = done.json()["encounterId"]
    return encounter


def _clinic_b_ai_on(practice: Practice) -> None:
    _sql(practice, "UPDATE admin.tenant SET ai_enabled = true WHERE id = :t", t=practice.clinic_b)
    _sql(practice, "INSERT INTO admin.ai_feature_setting (id, tenant_id, feature, is_enabled) "
         "VALUES (gen_random_uuid(), :t, 'chart-summary', true)", t=practice.clinic_b)


def test_the_brief_and_differential_follow_the_facility_rules(
        client: Any, practice: Practice, users: dict[str, CurrentUser],
        claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    _clinic_b_ai_on(practice)
    staff(practice, users, "fd-a2", "fd", facility=practice.other_facility)
    at_a1 = _visit(client, practice, at_a2=False, front_desk="fd")
    at_a2 = _visit(client, practice, at_a2=True, front_desk="fd-a2")
    claude_server.reply = json.dumps({"candidates": [], "insufficientEvidence": True})
    own = client("md").post(f"{API}/ai/differentials", json={"encounterId": at_a1})
    assert own.json()["status"] == "succeeded", own.text
    differential = own.json()["result"]["id"]
    claude_server.reply = json.dumps({"patients": []})
    brief = client("md").post(f"{API}/ai/morning-briefs", json={"date": _today()})
    assert brief.json()["status"] == "succeeded", brief.text
    brief_id = brief.json()["result"]["id"]
    rows = [
        Row("createDifferential", "md", "POST", f"{API}/ai/differentials", 404,
            json={"encounterId": at_a2}, note="a visit at A2"),
        Row("createDifferential", "md-b", "POST", f"{API}/ai/differentials", 404,
            json={"encounterId": at_a1}, note="another clinic"),
        Row("getDifferential", "md", "GET", f"{API}/ai/differentials/{differential}", 200,
            shown=(at_a1,)),
        Row("getDifferential", "md-b", "GET", f"{API}/ai/differentials/{differential}", 404,
            hidden=(at_a1,)),
        Row("getMorningBrief", "md", "GET", f"{API}/ai/morning-briefs/{brief_id}", 200),
        Row("getMorningBrief", "md-b", "GET", f"{API}/ai/morning-briefs/{brief_id}", 404),
        Row("createMorningBrief", "md-b", "POST", f"{API}/ai/morning-briefs", 202,
            json={"date": _today()}, hidden=(str(practice.patients["kaia"]),), writes=True,
            note="clinic B's own (empty) brief"),
    ]
    outcomes = sweep(client, practice, rows)
    assert not failures(outcomes), report(failures(outcomes))
    assert {o.row.operation for o in outcomes} == COVERED


def test_a_brief_lists_only_appointments_at_the_users_facilities(
        client: Any, practice: Practice, users: dict[str, CurrentUser],
        claude_server: StubClaudeServer) -> None:
    """A1's doctor linked to the provider who works at A2: the A2 appointment stays out."""
    _summary_on(client)
    doctor = staff(practice, users, "md-a1", "md")
    _sql(practice, "UPDATE admin.app_user SET practitioner_id = NULL WHERE practitioner_id = :p",
         p=practice.other_provider)
    _sql(practice, "UPDATE admin.app_user SET practitioner_id = :p WHERE id = :u",
         p=practice.other_provider, u=doctor.id)
    appointment_today(practice, "kaia", facility=practice.other_facility,
                      provider=practice.other_provider, hour=14, room=None)
    made = client("md-a1").post(f"{API}/ai/morning-briefs", json={"date": _today()})
    assert made.status_code == 202 and made.json()["status"] == "succeeded", made.text
    got = client("md-a1").get(f"{API}/ai/morning-briefs/{made.json()['result']['id']}")
    assert got.status_code == 200, got.text
    assert got.json()["appointments"] == []
    assert claude_server.requests == []
