"""Facility scope of eligibility, against the live database (SECURITY_MODEL §5.1, D37).

Check-in writes an eligibility check through this module's service (D15): a front desk user at
facility A1 checking in an A2 appointment, or clinic B checking in clinic A's, gets 404 and no
check is recorded, although the patient has a coverage that would be checked. The module's own
operations (runEligibilityCheck, getEligibilityCheck, listAppointmentEligibilityChecks; #166) are
swept the same way against the A2 visit's check. The first test fails when the module serves an
operation without a row here. Synthetic data only."""

from __future__ import annotations

import uuid
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
    served_operations,
    staff,
    sweep,
)
from app.modules.scheduling.tests.test_check_in_live import _coverage, _sql

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

#: The eligibility operations this module serves; each has rows in _served_rows.
SERVED = {"runEligibilityCheck", "getEligibilityCheck", "listAppointmentEligibilityChecks"}


def _check_in(appointment: str, user: str) -> Row:
    return Row("checkInAppointment", user, "POST", f"{API}/appointments/{appointment}/check-in",
               404, json={"selfPay": False}, headers={"Idempotency-Key": str(uuid.uuid4())},
               note="the only writer of eligibility checks today (D15)")


def test_the_table_covers_every_eligibility_operation_served() -> None:
    assert served_operations("eligibility") == SERVED, \
        "add sweep rows (_served_rows) for each eligibility operation served"


def _served_rows(appointment: str, check: str, coverage: uuid.UUID) -> list[Row]:
    """Another facility's (fd) and another clinic's (fd-b) front desk, on the A2 visit's check."""
    rows: list[Row] = []
    for user in ("fd", "fd-b"):
        rows += [
            Row("runEligibilityCheck", user, "POST", f"{API}/eligibility-checks", 404,
                json={"coverageId": str(coverage), "appointmentId": appointment},
                headers={"Idempotency-Key": str(uuid.uuid4())}, writes=True),
            Row("getEligibilityCheck", user, "GET", f"{API}/eligibility-checks/{check}", 404),
            Row("listAppointmentEligibilityChecks", user, "GET",
                f"{API}/appointments/{appointment}/eligibility-checks", 404, hidden=(check,)),
        ]
    return rows


def test_check_in_records_no_eligibility_check_for_another_facility_or_clinic(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    p = practice
    staff(p, users, "fd-a2", "fd", facility=p.other_facility)
    coverage = _coverage(p, "kaia")
    _coverage(p, "marcus")
    theirs = appointment_today(p, "kaia", facility=p.other_facility, provider=p.other_provider,
                               hour=14)
    mine = appointment_today(p, "marcus", facility=p.facility, provider=p.provider, hour=11,
                             room=p.room)
    outcomes = sweep(client, p, [_check_in(theirs, "fd"), _check_in(mine, "fd-b")])
    assert not failures(outcomes), report(failures(outcomes))
    # The control: each facility's own front desk checks in, and each records its check.
    checks = {}
    for appointment, user in ((theirs, "fd-a2"), (mine, "fd")):
        done = client(user).post(f"{API}/appointments/{appointment}/check-in", json={},
                                 headers={"Idempotency-Key": str(uuid.uuid4())})
        assert done.status_code == 200, done.text
        checks[appointment] = done.json()["eligibilityCheckId"]
        assert checks[appointment]
    served = sweep(client, p, _served_rows(theirs, checks[theirs], coverage))
    assert not failures(served), report(failures(served))
    # The control for the module's reads: A2's own front desk sees its visit's check.
    own = client("fd-a2").get(f"{API}/eligibility-checks/{checks[theirs]}")
    assert own.status_code == 200, own.text
    assert _sql(p, "SELECT count(*) FROM admin.eligibility_check WHERE tenant_id = :t",
                t=p.clinic)[0][0] == 2
