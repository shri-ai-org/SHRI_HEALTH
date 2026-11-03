"""Free times and the booking-hours check (slots.py): pure functions, no database."""

from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from ..reference import END_OF_DAY, AvailabilityRule, ScheduleException, since_midnight
from ..slots import Busy, day_bounds, free_slots, local_day, wall_clock, within_hours

ZONE = "America/Chicago"
PROVIDER, OTHER = uuid4(), uuid4()
SCHEDULE = uuid4()
FU, NEW = uuid4(), uuid4()
MONDAY = date(2035, 1, 8)  # far in the future, a Monday


def rule(day: str = "mon", start: int = 9, end: int = 11, step: int = 20,
         types: frozenset[UUID] = frozenset(), provider: UUID = PROVIDER) -> AvailabilityRule:
    """A rule from ``start`` to ``end`` o'clock; ``end=24`` is the end of the day (24:00)."""
    return AvailabilityRule(SCHEDULE, provider, day, timedelta(hours=start),
                            timedelta(hours=end), step, None, date(2020, 1, 1), None, types)


def at(hour: int, minute: int = 0, day: date = MONDAY) -> datetime:
    """A Chicago local time, in UTC (January: UTC-6)."""
    return datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(hours=hour + 6,
                                                                         minutes=minute)


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


# ------------------------------------------------------------- midnight and daylight saving
TUESDAY = date(2035, 1, 9)
FALL_BACK = date(2026, 11, 1)  # a Sunday: 1:00–2:00 happens twice, the day has 25 hours
SPRING_FORWARD = date(2026, 3, 8)  # a Sunday: 2:00–3:00 doesn't happen, the day has 23 hours


def test_since_midnight_and_the_end_of_the_day() -> None:
    assert since_midnight(time(9, 30)) == timedelta(hours=9, minutes=30)
    assert END_OF_DAY == timedelta(hours=24)
    assert wall_clock(MONDAY, END_OF_DAY, ZONE) == at(0, day=TUESDAY)
    assert wall_clock(MONDAY, END_OF_DAY, ZONE) == day_bounds(MONDAY, ZONE)[1]


def test_a_rule_ending_at_2400_runs_to_midnight() -> None:
    found = free_slots([rule(start=22, end=24)], [], [], MONDAY, ZONE, None, None)
    assert [s.start for s in found] == [at(22), at(22, 20), at(22, 40), at(23), at(23, 20),
                                        at(23, 40)]
    assert found[-1].end == at(0, day=TUESDAY)  # the last slot ends at 24:00


def test_the_last_slot_of_the_day_fits_the_visit_before_midnight() -> None:
    found = free_slots([rule(start=22, end=24)], [], [], MONDAY, ZONE, 40, None)
    assert found[-1].start == at(23, 20) and found[-1].end == at(0, day=TUESDAY)
    hour_long = free_slots([rule(start=23, end=24, step=20)], [], [], MONDAY, ZONE, 60, None)
    assert [(s.start, s.end) for s in hour_long] == [(at(23), at(0, day=TUESDAY))]


def test_a_rule_starting_at_0000_starts_at_local_midnight() -> None:
    found = free_slots([rule(start=0, end=2)], [], [], MONDAY, ZONE, None, None)
    assert found[0].start == day_bounds(MONDAY, ZONE)[0] == at(0)
    assert len(found) == 6


def test_no_slot_crosses_midnight() -> None:
    """Monday until 24:00 and Tuesday from 0:00 are two days' windows: no slot spans both,
    and a booking across midnight is outside the hours."""
    rules = [rule(start=23, end=24), rule(day="tue", start=0, end=1)]
    monday = free_slots(rules, [], [], MONDAY, ZONE, 40, None)
    tuesday = free_slots(rules, [], [], TUESDAY, ZONE, 40, None)
    assert [s.start for s in monday] == [at(23), at(23, 20)]
    assert [s.start for s in tuesday] == [at(0, day=TUESDAY), at(0, 20, day=TUESDAY)]
    assert all(s.end <= at(0, day=TUESDAY) for s in monday)
    assert within_hours(rules, [], PROVIDER, at(23, 40), at(0, day=TUESDAY), ZONE, FU)
    assert not within_hours(rules, [], PROVIDER, at(23, 40), at(0, 20, day=TUESDAY), ZONE, FU)


def test_a_whole_day_on_the_fall_back_day_has_25_hours_of_slots() -> None:
    found = free_slots([rule(day="sun", start=0, end=24, step=60)], [], [], FALL_BACK, ZONE,
                       None, None)
    assert len(found) == 25
    assert found[0].start == datetime(2026, 11, 1, 5, tzinfo=UTC)  # 0:00 CDT
    assert found[-1].end == datetime(2026, 11, 2, 6, tzinfo=UTC)  # 24:00 CST
    # 1:00 comes twice, an hour apart: the grid follows real time.
    assert [s.start.astimezone(ZoneInfo(ZONE)).hour for s in found[1:3]] == [1, 1]
    assert local_day(found[-1].start, ZONE) == FALL_BACK


def test_office_hours_keep_their_wall_clock_on_both_change_days() -> None:
    fall = free_slots([rule(day="sun", start=9, end=17)], [], [], FALL_BACK, ZONE, None, None)
    assert fall[0].start == datetime(2026, 11, 1, 15, tzinfo=UTC)  # 9:00 CST
    assert fall[-1].end == datetime(2026, 11, 1, 23, tzinfo=UTC)  # 17:00 CST
    spring = free_slots([rule(day="sun", start=9, end=17)], [], [], SPRING_FORWARD, ZONE, None,
                        None)
    assert spring[0].start == datetime(2026, 3, 8, 14, tzinfo=UTC)  # 9:00 CDT
    assert len(fall) == len(spring) == 24


def test_a_whole_day_on_the_spring_forward_day_has_23_hours_of_slots() -> None:
    found = free_slots([rule(day="sun", start=0, end=24, step=60)], [], [], SPRING_FORWARD,
                       ZONE, None, None)
    assert len(found) == 23
    assert found[0].start == datetime(2026, 3, 8, 6, tzinfo=UTC)  # 0:00 CST
    assert found[-1].end == datetime(2026, 3, 9, 5, tzinfo=UTC)  # 24:00 CDT
