"""Free times and the booking-hours check (slots.py): pure functions, no database."""

from datetime import UTC, date, datetime, time
from uuid import UUID, uuid4

from ..reference import AvailabilityRule, ScheduleException
from ..slots import Busy, day_bounds, free_slots, local_day, within_hours

ZONE = "America/Chicago"
PROVIDER, OTHER = uuid4(), uuid4()
SCHEDULE = uuid4()
FU, NEW = uuid4(), uuid4()
MONDAY = date(2035, 1, 8)  # far in the future, a Monday


def rule(day: str = "mon", start: int = 9, end: int = 11, step: int = 20,
         types: frozenset[UUID] = frozenset(), provider: UUID = PROVIDER) -> AvailabilityRule:
    return AvailabilityRule(SCHEDULE, provider, day, time(start), time(end), step, None,
                            date(2030, 1, 1), None, types)


def at(hour: int, minute: int = 0, day: date = MONDAY) -> datetime:
    """A Chicago local time, in UTC (January: UTC-6)."""
    return datetime(day.year, day.month, day.day, hour + 6, minute, tzinfo=UTC)


def test_the_grid_fills_the_window_in_the_facility_zone() -> None:
    found = free_slots([rule()], [], [], MONDAY, ZONE, None, None)
    assert [s.start for s in found] == [at(9), at(9, 20), at(9, 40), at(10), at(10, 20),
                                        at(10, 40)]
    assert all((s.end - s.start).total_seconds() == 1200 for s in found)


def test_a_longer_visit_needs_room_before_the_window_ends() -> None:
    found = free_slots([rule()], [], [], MONDAY, ZONE, 40, None)
    assert found[-1].start == at(10, 20)  # 10:20 + 40 minutes = 11:00


def test_booked_appointments_and_blocks_take_their_times_away() -> None:
    busy = [Busy(PROVIDER, at(9, 20), at(9, 40)), Busy(OTHER, at(9), at(11))]
    block = ScheduleException(SCHEDULE, PROVIDER, at(10, 30), at(11), False)
    found = free_slots([rule()], [block], busy, MONDAY, ZONE, None, None)
    assert [s.start for s in found] == [at(9), at(9, 40), at(10)]


def test_extra_availability_adds_a_window() -> None:
    extra = ScheduleException(SCHEDULE, PROVIDER, at(13), at(13, 40), True)
    found = free_slots([rule()], [extra], [], MONDAY, ZONE, None, None)
    assert [s.start for s in found][-2:] == [at(13), at(13, 20)]


def test_rules_apply_only_on_their_weekday_their_dates_and_their_types() -> None:
    assert free_slots([rule(day="tue")], [], [], MONDAY, ZONE, None, None) == []
    only_new = rule(types=frozenset({NEW}))
    assert free_slots([only_new], [], [], MONDAY, ZONE, None, FU) == []
    assert free_slots([only_new], [], [], MONDAY, ZONE, None, NEW)


def test_past_times_are_left_out() -> None:
    found = free_slots([rule()], [], [], MONDAY, ZONE, None, None, not_before=at(10))
    assert found[0].start == at(10)


def test_local_times_survive_daylight_saving() -> None:
    summer = date(2035, 7, 9)  # a Monday, UTC-5
    found = free_slots([rule()], [], [], summer, ZONE, None, None)
    assert found[0].start == datetime(2035, 7, 9, 14, 0, tzinfo=UTC)  # 9:00 CDT
    start, end = day_bounds(summer, ZONE)
    assert start == datetime(2035, 7, 9, 5, tzinfo=UTC) and (end - start).days == 1
    assert local_day(datetime(2035, 7, 10, 3, tzinfo=UTC), ZONE) == summer


def test_within_hours_allows_any_start_in_a_window_but_not_a_block() -> None:
    block = ScheduleException(SCHEDULE, PROVIDER, at(10), at(10, 30), False)
    assert within_hours([rule()], [], PROVIDER, at(9, 5), at(9, 25), ZONE, FU)
    assert not within_hours([rule()], [], PROVIDER, at(10, 50), at(11, 10), ZONE, FU)
    assert not within_hours([rule()], [block], PROVIDER, at(10, 10), at(10, 30), ZONE, FU)
    assert not within_hours([rule()], [], OTHER, at(9), at(9, 20), ZONE, FU)
