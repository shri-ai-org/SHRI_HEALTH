"""A front-desk user (no grant, not on the care team) and a restricted patient (D37, D109), on
the reads the front desk's screens make: the chart, the minimum-necessary summaries (D54), the
patient's appointments (#292) and the after-visit summary link. Synthetic data only."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from app.core import download_tokens as core_tokens
from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.files.tests.fakes import download_tokens

from .conftest import Practice, make_client
from .test_check_in_live import _check_in, _today_appointment

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"


@pytest.fixture
def desk(users: dict[str, CurrentUser]) -> Iterator[Any]:
    """The live client with the files module's test download tokens (no token secret here)."""
    tokens = download_tokens()
    yield from make_client(users, pending=False,
                           overrides={core_tokens.download_tokens: lambda: tokens})


def test_the_front_desk_and_a_restricted_chart(desk: Any, practice: Practice,
                                               users: dict[str, CurrentUser]) -> None:
    client = desk
    patient = str(practice.patients["restricted"])
    visit = _check_in(client, _today_appointment(practice, "restricted"), selfPay=True)
    assert visit.status_code == 200, visit.text  # check-in works without break-glass (D107)
    encounter = visit.json()["encounterId"]
    answers = {
        "getPatient": client("fd").get(f"{API}/patients/{patient}"),
        "getPatientSummaries": client("fd").post(f"{API}/patients/summaries",
                                                 json={"patientIds": [patient]}),
        "listPatientAppointments": client("fd").get(f"{API}/patients/{patient}/appointments"),
        "getAfterVisitSummaryDownloadUrl": client("fd").get(
            f"{API}/encounters/{encounter}/after-visit-summary/download-url"),
    }
    seen = {op: (r.status_code, r.json().get("code") if r.status_code >= 400 else None)
            for op, r in answers.items()}
    assert seen["getPatient"] == (403, "break-glass-required")
    # Summary fields only, flagged restricted, as search (SECURITY_MODEL §5.2; D54).
    assert seen["getPatientSummaries"] == (200, None)
    assert answers["getPatientSummaries"].json()["items"][0]["restricted"] is True
    assert seen["listPatientAppointments"] == (403, "break-glass-required")
    assert seen["getAfterVisitSummaryDownloadUrl"] == (403, "break-glass-required")  # D109
