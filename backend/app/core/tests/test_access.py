"""Facility scope without a database. Restricted charts are tested in test_access_postgres.py."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import ColumnElement, column
from sqlalchemy.dialects import postgresql

from app.core.access import (
    ChartAccess,
    check_facility_query,
    facility_filter,
    facility_scope,
    require_facility,
)
from app.core.deps import DEV_USERS, FACILITY_A, FACILITY_B, CurrentUser
from app.core.errors import NotFound

MD = DEV_USERS["md"]  # assigned to facility A only


PG = postgresql.dialect()  # type: ignore[no-untyped-call]


def _sql(clause: ColumnElement[bool]) -> str:
    return str(clause.compile(dialect=PG, compile_kwargs={"literal_binds": True}))


def test_facility_filter_limits_to_the_users_facilities() -> None:
    assert _sql(facility_filter(MD, column("facility_id"))) == (
        f"facility_id IN ('{FACILITY_A}')")


def test_a_user_with_no_facilities_sees_nothing() -> None:
    nobody = CurrentUser(id=uuid4(), organization_id=MD.organization_id, roles=frozenset({"MD"}))
    assert _sql(facility_filter(nobody, column("facility_id"))) == "false"
    assert facility_scope(nobody) == frozenset()


def test_require_facility_answers_404_for_another_facility() -> None:
    assert require_facility(MD, FACILITY_A) == FACILITY_A
    for other in (FACILITY_B, uuid4(), None):
        with pytest.raises(NotFound):
            require_facility(MD, other)


def test_facility_scope_is_the_filter_or_all_of_the_users() -> None:
    assert facility_scope(MD) == frozenset({FACILITY_A})
    assert facility_scope(MD, FACILITY_A) == frozenset({FACILITY_A})
    with pytest.raises(NotFound):
        facility_scope(MD, FACILITY_B)


def test_the_facility_query_check() -> None:
    check_facility_query(MD, [str(FACILITY_A)])
    check_facility_query(MD, ["not-a-uuid"])  # left to request validation (422)
    with pytest.raises(NotFound):
        check_facility_query(MD, [str(FACILITY_A), str(FACILITY_B)])  # every value is checked


@pytest.mark.parametrize(("access", "allowed"), [
    (ChartAccess.OPEN, True), (ChartAccess.CARE_TEAM, True), (ChartAccess.BREAK_GLASS, True),
    (ChartAccess.BLOCKED, False), (ChartAccess.NOT_FOUND, False),
])
def test_which_chart_access_is_allowed(access: ChartAccess, allowed: bool) -> None:
    assert access.allowed is allowed


def test_facilities_are_uuids() -> None:
    assert all(isinstance(f, UUID) for f in MD.facility_ids)
