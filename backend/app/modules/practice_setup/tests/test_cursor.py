"""The temporary, unsigned cursor (cursor.py): round trip, and strict refusal of anything else."""

import base64
import json
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pytest

from app.core.errors import InvalidCursor

from ..cursor import KEY_TYPES, Position, decode, encode


def _raw(payload: Any) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()


@pytest.mark.parametrize("kind", sorted(KEY_TYPES))
def test_round_trip(kind: Any) -> None:
    key: Any = (datetime(2026, 10, 26, 13, 0, 0, 123456, tzinfo=UTC)
                if KEY_TYPES[kind] is datetime else "Test Clinic é / 100%")
    position = Position(kind=kind, key=key, id=uuid4())
    value = encode(position)
    assert value.isascii() and "=" not in value and len(value) <= 512
    assert decode(value, kind) == position


def test_an_offset_time_keeps_its_instant() -> None:
    at = datetime(2026, 10, 26, 8, 0, tzinfo=timezone(timedelta(hours=-5)))
    position = Position(kind="providers", key=at, id=uuid4())
    assert decode(encode(position), "providers").key == at


def test_encode_refuses_the_wrong_key_type() -> None:
    with pytest.raises(TypeError):
        encode(Position(kind="providers", key="not a time", id=uuid4()))


@pytest.mark.parametrize("value", [
    "", "A", "!!!!", "bm90LWEtY3Vyc29y", "e30", "W10", "bnVsbA",
    _raw({"v": 1, "k": "providers", "s": "2026-10-26T13:00:00+00:00", "i": str(uuid4())}),
    _raw({"v": 2, "k": "facilities", "s": "x", "i": str(uuid4())}),
    _raw({"v": "1", "k": "facilities", "s": "x", "i": str(uuid4())}),
    _raw({"v": True, "k": "facilities", "s": "x", "i": str(uuid4())}),
    _raw({"v": 1, "k": "facilities", "s": None, "i": str(uuid4())}),
    _raw({"v": 1, "k": "facilities", "s": ["x"], "i": str(uuid4())}),
    _raw({"v": 1, "k": "facilities", "s": "x", "i": 5}),
    _raw({"v": 1, "k": "facilities", "s": "x", "i": "nope"}),
    _raw({"v": 1, "k": "facilities", "s": "x", "i": str(uuid4()).upper()}),
    _raw({"v": 1, "k": "facilities", "s": "x", "i": uuid4().hex}),
    _raw({"v": 1, "k": "facilities", "s": "x"}),
    _raw({"v": 1, "k": "facilities", "s": "x", "i": str(uuid4()), "t": "y"}),
])
def test_anything_else_is_invalid_for_facilities(value: str) -> None:
    with pytest.raises(InvalidCursor):
        decode(value, "facilities")


@pytest.mark.parametrize("key", ["yesterday", "2026-10-26T13:00:00", "2026-13-01T00:00:00Z"])
def test_a_time_key_must_be_an_instant(key: str) -> None:
    with pytest.raises(InvalidCursor):
        decode(_raw({"v": 1, "k": "providers", "s": key, "i": str(uuid4())}), "providers")
