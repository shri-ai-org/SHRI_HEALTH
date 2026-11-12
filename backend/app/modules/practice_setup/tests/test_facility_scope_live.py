"""Facility scope of createProvider and createProviderSchedule, against the live database
(SECURITY_MODEL §5.1, D37; Vimal's #276 review). A user at facility A1 creating a provider or a
schedule at A2, and a clinic-B user naming clinic A's facility or provider, get
`422 invalid-reference` and nothing in either clinic changes. Uses scheduling's live practice,
users and client, as the other modules' sweeps do. Synthetic data only."""

from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

import pytest

from app.core.deps import CurrentUser
from app.db.tests import builders as b
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice, client, practice, users  # noqa: F401
from app.modules.scheduling.tests.facility_scope import API, Row, failures, report, staff, sweep

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]


def _provider(facility: UUID) -> dict[str, Any]:
    return {"name": {"family": "Lindgren118", "given": ["Kaia401"], "prefix": "Dr."},
            "npi": b.npi(), "facilityIds": [str(facility)]}


def _schedule(provider: UUID, facility: UUID) -> dict[str, Any]:
    return {"providerId": str(provider), "facilityId": str(facility),
            "availabilityRules": [{"dayOfWeek": "mon", "startTime": "09:00", "endTime": "12:00",
                                   "slotMinutes": 20, "startDate": "2026-12-01"}]}


def _rows(p: Practice) -> list[tuple[Row, str]]:
    """Each refused call, with the field its invalid-reference names."""
    def row(op: str, user: str, path: str, body: dict[str, Any]) -> Row:
        return Row(op, user, "POST", f"{API}/{path}", 422, json=body,
                   headers={"Idempotency-Key": str(uuid.uuid4())})
    return [
        (row("createProvider", "adm", "providers", _provider(p.other_facility)),
         "/facilityIds/0"),
        (row("createProviderSchedule", "fd", "provider-schedules",
             _schedule(p.other_provider, p.other_facility)), "/facilityId"),
        (row("createProvider", "adm-b", "providers", _provider(p.facility)), "/facilityIds/0"),
        (row("createProviderSchedule", "fd-b", "provider-schedules",
             _schedule(p.provider, p.facility_b)), "/providerId"),
    ]


def test_providers_and_schedules_only_at_the_users_facilities(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:  # noqa: F811
    staff(practice, users, "adm-b", "adm", clinic_b=True)
    rows = _rows(practice)
    outcomes = sweep(client, practice, [r for r, _ in rows])
    assert not failures(outcomes), report(failures(outcomes))
    for r, pointer in rows:                   # the same calls again, for the field and code
        answer = client(r.user).post(r.path, json=r.json,
                                     headers={"Idempotency-Key": str(uuid.uuid4())})
        assert answer.status_code == 422, answer.text
        assert answer.json()["code"] == "business-rule-violation", answer.text
        assert {(e["pointer"], e["code"]) for e in answer.json()["errors"]} == {
            (pointer, "invalid-reference")}, (r.operation, r.user, answer.text)
