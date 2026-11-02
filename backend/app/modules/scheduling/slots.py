"""Free times: availability rules minus exceptions minus booked appointments (inventory #50).

Pure functions, no database: the rules are local facility times and are laid out on the day in
the facility's IANA time zone (D40), so a clinic's 9:00 stays 9:00 across daylight-saving changes.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from .reference import AvailabilityRule, ScheduleException

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


@dataclass(frozen=True)
class Busy:
    """An appointment that blocks its provider (the database's own blocking rule)."""

    provider_id: UUID
    start: datetime
    end: datetime


@dataclass(frozen=True)
class FreeSlot:
    start: datetime  # UTC
    end: datetime
    provider_id: UUID
    location_id: UUID | None


def day_bounds(day: date, zone: str) -> tuple[datetime, datetime]:
    """[start, end) of a local day, in UTC."""
    tz = ZoneInfo(zone)
    start = datetime.combine(day, datetime.min.time(), tz)
    end = datetime.combine(day + timedelta(days=1), datetime.min.time(), tz)
    return start.astimezone(UTC), end.astimezone(UTC)


def local_day(moment: datetime, zone: str) -> date:
    return moment.astimezone(ZoneInfo(zone)).date()


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def windows(rules: Iterable[AvailabilityRule], exceptions: Iterable[ScheduleException],
            day: date, zone: str, appointment_type_id: UUID | None
            ) -> list[tuple[UUID, datetime, datetime, int, UUID | None]]:
    """The provider's open windows on the day: (provider, start, end, step minutes, location),
    in UTC. Rules for the weekday that apply to the day and the type, plus extra-availability
    exceptions (with the provider's shortest rule step, or 20 minutes)."""
    tz = ZoneInfo(zone)
    weekday = DAYS[day.weekday()]
    found = []
    steps: dict[UUID, int] = {}
    for rule in rules:
        steps[rule.provider_id] = min(steps.get(rule.provider_id, rule.slot_minutes),
                                      rule.slot_minutes)
        if rule.day_of_week != weekday or not rule.applies(day, appointment_type_id):
            continue
        start = datetime.combine(day, rule.start_time, tz).astimezone(UTC)
        end = datetime.combine(day, rule.end_time, tz).astimezone(UTC)
        found.append((rule.provider_id, start, end, rule.slot_minutes, rule.location_id))
    day_start, day_end = day_bounds(day, zone)
    for exc in exceptions:
        if exc.is_available and _overlaps(exc.start_at, exc.end_at, day_start, day_end):
            found.append((exc.provider_id, max(exc.start_at, day_start),
                          min(exc.end_at, day_end), steps.get(exc.provider_id, 20), None))
    return found


def free_slots(rules: Sequence[AvailabilityRule], exceptions: Sequence[ScheduleException],
               busy: Sequence[Busy], day: date, zone: str, duration_minutes: int | None,
               appointment_type_id: UUID | None, not_before: datetime | None = None
               ) -> list[FreeSlot]:
    """Every start on each window's grid where a visit of ``duration_minutes`` (default: the
    grid step) fits the window, overlaps no block and no booked appointment of the provider, and
    starts at or after ``not_before`` (now, for today). Sorted by start, then provider."""
    blocks = [e for e in exceptions if not e.is_available]
    out: dict[tuple[datetime, UUID], FreeSlot] = {}
    for provider, start, end, step, location in windows(rules, exceptions, day, zone,
                                                         appointment_type_id):
        length = timedelta(minutes=duration_minutes or step)
        at = start
        while at + length <= end:
            slot_end = at + length
            free = (not_before is None or at >= not_before) and not any(
                b.provider_id == provider and _overlaps(at, slot_end, b.start_at, b.end_at)
                for b in blocks) and not any(
                b.provider_id == provider and _overlaps(at, slot_end, b.start, b.end)
                for b in busy)
            if free and (at, provider) not in out:
                out[(at, provider)] = FreeSlot(at, slot_end, provider, location)
            at += timedelta(minutes=step)
    return sorted(out.values(), key=lambda s: (s.start, str(s.provider_id)))


def within_hours(rules: Sequence[AvailabilityRule], exceptions: Sequence[ScheduleException],
                 provider_id: UUID, start: datetime, end: datetime, zone: str,
                 appointment_type_id: UUID) -> bool:
    """Whether [start, end) lies inside one of the provider's open windows that day (any grid
    position: a booking may start off the grid) and overlaps none of the provider's blocks."""
    day = local_day(start, zone)
    if local_day(end - timedelta(microseconds=1), zone) != day:
        return False
    inside = any(p == provider_id and w_start <= start and end <= w_end
                 for p, w_start, w_end, _, _ in windows(rules, exceptions, day, zone,
                                                         appointment_type_id))
    blocked = any(e.provider_id == provider_id and not e.is_available
                  and _overlaps(start, end, e.start_at, e.end_at) for e in exceptions)
    return inside and not blocked
