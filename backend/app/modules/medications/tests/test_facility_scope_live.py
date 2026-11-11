"""The facility and clinic rules for the medications module's visit reads, through scheduling's
sweep (facility_scope.py): a visit's prescriptions (gap 82) are the visit's facility's, and
another clinic's are 404. The module's other operations have their own live tests; rows join
this table as their reads are swept. Synthetic data only."""

from __future__ import annotations

from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.conftest import client as client  # noqa: F401 (fixture)
from app.modules.scheduling.tests.conftest import practice as practice  # noqa: F401 (fixture)
from app.modules.scheduling.tests.conftest import users as users  # noqa: F401 (fixture)
from app.modules.scheduling.tests.facility_scope import API, Row, failures, report, staff, sweep

from .test_medications_live import Rx, _draft
from .test_medications_live import _transit as _transit  # noqa: F401 (autouse fixture)
from .test_medications_live import rx as rx  # noqa: F401 (fixture)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]


def test_a_visits_prescriptions_follow_the_facility_and_clinic_rules(
        client: Any, practice: Practice, users: dict[str, CurrentUser], rx: Rx) -> None:
    staff(practice, users, "md-a2", "md", facility=practice.other_facility)
    draft = _draft(client, practice, rx).json()["id"]
    url = f"{API}/encounters/{rx.encounter}/prescriptions"
    outcomes = sweep(client, practice, [
        Row("listEncounterPrescriptions", "md", "GET", url, 200, shown=(draft,)),
        Row("listEncounterPrescriptions", "md-a2", "GET", url, 404, hidden=(draft,),
            note="a visit at A1, read from A2"),
        Row("listEncounterPrescriptions", "md-b", "GET", url, 404, hidden=(draft,)),
    ])
    assert not failures(outcomes), report(failures(outcomes))
