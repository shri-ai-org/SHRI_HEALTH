"""Who may record each visit step (DATA_OWNERSHIP §5.1, §5.2; VISIT_STEP_ROLES), with in-memory
fakes for the appointment reads and writes, the encounter steps and the event log, so a refused
call can be shown to write nothing. Synthetic data only."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.deps import CLINIC_A, FACILITY_A, CurrentUser
from app.core.errors import AppError

from ...encounters import service as encounters
from .. import repository as repo
from .. import schemas, service
from ..reference import LocationRow
from ..repository import AppointmentRow

NOW = datetime(2026, 11, 3, 18, 0, tzinfo=UTC)  # noon in Chicago
ROOM = uuid4()


@dataclass
class Row:
    status: str


@dataclass
class World:
    """The appointment and its encounter, and every write the service made."""
    appointment: str
    encounter: str = "arrived"
    start: datetime = NOW - timedelta(hours=1)
    writes: list[str] = field(default_factory=list)


def _row(world: World) -> AppointmentRow:
    return AppointmentRow(
        id=uuid4(), version=1, status=world.appointment, start=world.start,
        end=world.start + timedelta(minutes=20), minutes=20, patient_id=uuid4(),
        provider_id=None, location_id=None, facility_id=FACILITY_A,
        time_zone="America/Chicago", type_id=None, type_code=None, type_name=None, reason=None,
        comment=None, patient_instruction=None, same_day_add_on=False, overbook=False,
        cancel_code=None, cancel_text=None, cancelled_at=None, rescheduled_from_id=None,
        encounter_id=None, visit_status=None, visit_status_at=None, room_name=None,
        created_at=NOW, updated_at=NOW)


class Ref:
    async def locations(self, db: Any, facility_ids: Any) -> list[LocationRow]:
        return [LocationRow(ROOM, FACILITY_A, "Exam 1", "ro")]


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> Any:
    def install(world: World) -> World:
        async def get(db: Any, appointment_id: UUID) -> AppointmentRow:
            return _row(world)

        async def locked(db: Any, appointment_id: UUID) -> Row:
            return Row(world.appointment)

        async def db_now(db: Any) -> datetime:
            return NOW

        async def set_status(db: Any, row: Row, status: str) -> None:
            world.writes.append(f"appointment:{status}")
            world.appointment = status

        async def add_visit_step(db: Any, appointment_id: UUID, step: str, at: datetime,
                                 location_id: UUID | None = None) -> None:
            world.writes.append(f"step:{step}")

        async def live(db: Any, appointment_id: UUID) -> UUID:
            return uuid4()

        async def room(db: Any, encounter_id: UUID, location_id: UUID) -> str:
            world.writes.append("encounter:triaged")
            world.encounter = "triaged"
            return "triaged"

        async def with_provider(db: Any, encounter_id: UUID) -> str:
            world.writes.append("encounter:in-progress")
            world.encounter = "in-progress"
            return "in-progress"

        async def publish(db: Any, kind: str, *args: Any, **kwargs: Any) -> UUID:
            world.writes.append(f"event:{kind}")
            return uuid4()

        for name, value in (("get", get), ("locked", locked), ("db_now", db_now),
                            ("set_status", set_status), ("add_visit_step", add_visit_step)):
            monkeypatch.setattr(repo, name, value)
        monkeypatch.setattr(encounters, "live_for_appointment", live)
        monkeypatch.setattr(encounters, "room", room)
        monkeypatch.setattr(encounters, "start_with_provider", with_provider)
        monkeypatch.setattr(service, "publish", publish)
        return world
    return install


def _user(*roles: str) -> CurrentUser:
    return CurrentUser(id=uuid4(), organization_id=CLINIC_A, roles=frozenset(roles),
                       facility_ids=frozenset({FACILITY_A}))


def _body(status: str) -> schemas.StatusChangeRequest:
    return schemas.StatusChangeRequest.model_validate(
        {"status": status, "roomLocationId": ROOM if status == "roomed" else None})


# The appointment status each step starts from.
FROM = {"arrived": "booked", "noshow": "booked", "roomed": "checked-in",
        "with-provider": "checked-in"}


@pytest.mark.parametrize(("role", "status"), [
    ("FD", "roomed"), ("FD", "with-provider"),
    ("MA", "with-provider"), ("MA", "arrived"), ("MA", "noshow"),
    ("MD", "roomed"), ("APP", "roomed"), ("RN", "arrived"), ("RN", "noshow"),
])
async def test_a_role_outside_the_step_is_refused_and_nothing_is_written(
        fake: Any, role: str, status: str) -> None:
    world = fake(World(appointment=FROM[status]))
    with pytest.raises(AppError) as refused:
        await service.record_status(None, Ref(), _user(role), uuid4(),  # type: ignore[arg-type]
                                    _body(status), NOW)
    assert refused.value.status == 403 and refused.value.code == "permission-denied"
    assert world.writes == []
    assert (world.appointment, world.encounter) == (FROM[status], "arrived")


@pytest.mark.parametrize(("role", "status", "written"), [
    ("FD", "arrived", ["appointment:arrived", "step:arrived"]),
    ("FD", "noshow", ["appointment:noshow"]),
    ("MA", "roomed", ["encounter:triaged", "step:roomed"]),
    ("RN", "roomed", ["encounter:triaged", "step:roomed"]),
    ("RN", "with-provider", ["encounter:in-progress", "step:with-provider"]),
    ("MD", "with-provider", ["encounter:in-progress", "step:with-provider"]),
    ("APP", "with-provider", ["encounter:in-progress", "step:with-provider"]),
])
async def test_each_allowed_role_records_its_step(fake: Any, role: str, status: str,
                                                  written: list[str]) -> None:
    world = fake(World(appointment=FROM[status]))
    await service.record_status(None, Ref(), _user(role), uuid4(),  # type: ignore[arg-type]
                                _body(status), NOW)
    assert [w for w in world.writes if not w.startswith("event:")] == written
    assert "event:appointment.status-changed" in world.writes


def test_every_step_has_its_roles() -> None:
    assert set(service.VISIT_STEP_ROLES) == {"arrived", "noshow", "roomed", "with-provider"}
