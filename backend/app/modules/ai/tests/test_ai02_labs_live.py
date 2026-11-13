"""AI-02 reads lab results (V11): with ``results:read`` the summary is sent the latest final
value of each test and the abnormal values of the last year, each line citing its Observation;
without it, no result is read and the gap is named; preliminary reports and entered-in-error
values are never sent. Live database, local stand-in for the Claude API. Synthetic data only."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import permissions
from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.orders.tests.test_results_live import _finish, _observation, _report
from app.modules.scheduling.tests.conftest import Practice

from .stub_claude_server import StubClaudeServer
from .test_ai02_live import SUMMARIES, _summary_on

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

Client = Callable[[str], TestClient]


def _ago(days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat()


def _labs(practice: Practice) -> dict[str, str]:
    patient = str(practice.patients["kaia"])
    recent = _report(practice, patient, "LAB", "57698-3", "Lipid panel", _ago(10))
    ids = {
        "ldl": _observation(practice, recent, patient, 1, "13457-7", "LDL cholesterol",
                            value=162, unit="mg/dL", low=0, high=99, flag="H"),
        "wrong": _observation(practice, recent, patient, 2, "2093-3", "Total cholesterol",
                              value=999, unit="mg/dL", status="entered-in-error"),
    }
    older = _report(practice, patient, "LAB", "57698-3", "Lipid panel", _ago(150))
    ids["ldl_older"] = _observation(practice, older, patient, 1, "13457-7", "LDL cholesterol",
                                    value=171, unit="mg/dL", flag="H")
    draft = _report(practice, patient, "LAB", "24323-8", "Metabolic panel", _ago(1),
                    status="preliminary")
    ids["potassium"] = _observation(practice, draft, patient, 1, "2823-3", "Potassium",
                                    value=6.1, unit="mmol/L", flag="H", status="preliminary")
    _finish(practice)
    return ids


def _sent(client: Client, claude_server: StubClaudeServer, patient: str) -> str:
    claude_server.reply = "{}"
    client("md").post(SUMMARIES, json={"patientId": patient})
    return str(claude_server.requests[-1]["messages"][0]["content"][0]["text"])


def test_final_lab_results_are_sent_and_cited(client: Client, practice: Practice,
                                              users: dict[str, CurrentUser],
                                              claude_server: StubClaudeServer) -> None:
    _summary_on(client)
    ids = _labs(practice)
    patient = str(practice.patients["kaia"])
    sent = _sent(client, claude_server, patient)
    assert "Lab result: LDL cholesterol 162 mg/dL (high; reference 0 mg/dL to 99 mg/dL)" in sent
    assert "Lab result: LDL cholesterol 171 mg/dL (high)" in sent        # abnormal, this year
    assert "Total cholesterol" not in sent and "999" not in sent          # entered-in-error
    assert "Potassium" not in sent                                        # preliminary
    assert "lab results (no permission)" not in sent
    assert patient not in sent and ids["ldl"] not in sent                 # names, never IDs
    handle = next(line.split(":", 1)[0] for line in sent.splitlines()
                  if "LDL cholesterol 162" in line)
    claude_server.reply = json.dumps({"sections": [{"topic": "results", "statements": [
        {"text": "LDL cholesterol is high at 162 mg/dL.", "sources": [handle]}]}],
        "missing": []})
    made = client("md").post(SUMMARIES, json={"patientId": patient},
                             headers={"Idempotency-Key": str(uuid.uuid4())})
    assert made.status_code == 202, made.text
    body = client("md").get(f"{SUMMARIES}/{made.json()['result']['id']}").json()
    statement = body["sections"][0]["statements"][0]
    assert body["sections"][0]["topic"] == "results"
    assert statement["sourceStatus"] == "sourced"
    assert [(s["resourceType"], s["resourceId"]) for s in statement["sources"]] == [
        ("Observation", ids["ldl"])]


def test_without_results_read_no_result_is_sent(client: Client, practice: Practice,
                                                users: dict[str, CurrentUser],
                                                claude_server: StubClaudeServer,
                                                monkeypatch: pytest.MonkeyPatch) -> None:
    _summary_on(client)
    _labs(practice)
    monkeypatch.setitem(permissions.ROLE_PERMISSIONS, "MD",
                        permissions.ROLE_PERMISSIONS["MD"] - {"results:read"})
    sent = _sent(client, claude_server, str(practice.patients["kaia"]))
    assert "Lab result:" not in sent and "LDL" not in sent
    assert "lab results (no permission)" in sent.split("Not available: ", 1)[1]
