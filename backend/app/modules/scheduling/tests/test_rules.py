"""The appointment list's date rules (D62), initials for shared screens (D47) and cursors."""

from datetime import date
from uuid import uuid4

import pytest

from app.core.errors import AppError

from ..service import date_range, decode_cursor, encode_cursor, initials, page

DAY = date(2035, 1, 8)


def _code(error: AppError) -> dict[str, str]:
    errors: list[dict[str, str]] = error.extensions["errors"]
    return errors[0]


def test_one_day_a_range_or_a_patient() -> None:
    assert date_range(DAY, None, None, None) == (DAY, DAY)
    assert date_range(None, DAY, date(2035, 2, 7), None) == (DAY, date(2035, 2, 7))  # 31 days
    assert date_range(None, None, None, uuid4()) is None


@pytest.mark.parametrize(("args", "name", "code"), [
    ((None, DAY, date(2035, 2, 8), None), "dateTo", "out-of-range"),  # 32 days (D62)
    ((None, DAY, date(2035, 1, 7), None), "dateTo", "out-of-range"),  # backwards
    ((DAY, DAY, DAY, None), "date", "conflicting-fields"),
    ((None, DAY, None, None), "dateTo", "required"),
    ((None, None, None, None), "date", "required"),
])
def test_a_bad_range_is_422_naming_the_parameter(args, name, code) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(AppError) as raised:
        date_range(*args)
    assert raised.value.code == "validation-failed"
    assert _code(raised.value) == {"in": "query", "name": name, "code": code}


def test_initials_skip_synthea_digits() -> None:
    assert initials("Kaia401", "Lindgren118") == "KL"
    assert initials("", "") == "?"


def test_cursors_round_trip_and_tampering_is_400() -> None:
    items, cursor = page(list(range(5)), 2, 0)
    assert items == [0, 1] and cursor is not None and decode_cursor(cursor) == 2
    assert page(list(range(5)), 2, 4) == ([4], None)
    assert decode_cursor(encode_cursor(7)) == 7
    with pytest.raises(AppError) as raised:
        decode_cursor("bm9wZQ")
    assert raised.value.code == "invalid-cursor"
