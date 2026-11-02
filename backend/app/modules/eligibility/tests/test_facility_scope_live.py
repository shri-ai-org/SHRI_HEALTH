"""Facility scope of eligibility, against the live database (SECURITY_MODEL §5.1, D37).

The module serves no operation yet (runEligibilityCheck, getEligibilityCheck and
listAppointmentEligibilityChecks are in the contract, not built): the first test fails as soon
as one is, so its rows get added here. Today an eligibility check is written only by check-in
(D15), through this module's service: a front desk user at facility A1 checking in an A2
appointment, or clinic B checking in clinic A's, gets 404 and no check is recorded, although the
patient has a coverage that would be checked. Synthetic data only."""

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

#: The eligibility operations this module serves, with their sweep rows (none yet).
SERVED: dict[str, list[Row]] = {}
NOT_BUILT = ("runEligibilityCheck", "getEligibilityCheck", "listAppointmentEligibilityChecks")


def _check_in(appointment: str, user: str) -> Row:
    return Row("checkInAppointment", user, "POST", f"{API}/appointments/{appointment}/check-in",
               404, json={"selfPay": False}, headers={"Idempotency-Key": str(uuid.uuid4())},
               note="the only writer of eligibility checks today (D15)")


def test_the_table_covers_every_eligibility_operation_served() -> None:
    assert served_operations("eligibility") == SERVED.keys(), \
        f"add sweep rows for each eligibility operation served (contract: {', '.join(NOT_BUILT)})"


def test_check_in_records_no_eligibility_check_for_another_facility_or_clinic(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    p = practice
    staff(p, users, "fd-a2", "fd", facility=p.other_facility)
    _coverage(p, "kaia")
    _coverage(p, "marcus")
    theirs = appointment_today(p, "kaia", facility=p.other_facility, provider=p.other_provider,
                               hour=14)
    mine = appointment_today(p, "marcus", facility=p.facility, provider=p.provider, hour=11,
                             room=p.room)
    rows = [_check_in(theirs, "fd"), _check_in(mine, "fd-b"),
            *[r for rows in SERVED.values() for r in rows]]
    outcomes = sweep(client, p, rows)
    assert not failures(outcomes), report(failures(outcomes))
    # The control: each facility's own front desk checks in, and each records its check.
    for appointment, user in ((theirs, "fd-a2"), (mine, "fd")):
        done = client(user).post(f"{API}/appointments/{appointment}/check-in", json={},
                                 headers={"Idempotency-Key": str(uuid.uuid4())})
        assert done.status_code == 200, done.text
        assert done.json()["eligibilityCheckId"]
    assert _sql(p, "SELECT count(*) FROM admin.eligibility_check WHERE tenant_id = :t",
                t=p.clinic)[0][0] == 2
