"""A list's keyset position <-> the opaque `cursor` query parameter (API_STANDARDS §8.1).

UNSIGNED AND TEMPORARY. The agreed cursor is encrypted and authenticated by core's middleware
(AES-GCM, key from OpenBao, tenant, user and endpoint as associated data, expiry inside: Thulasi,
T22). That middleware has not landed, so for now a cursor is only base64url (no padding) of a
small JSON object naming the list it belongs to:

    {"v": 1, "k": "<kind>", "s": "<sort key>", "i": "<row id>"}

Anyone can read and forge it. That is acceptable only because every list here is practice
configuration, never patient data, and a forged position can only move within what row-level
security already lets the caller see. When T22 lands, `encode` and `decode` are the only two
functions to replace; the repository and the routes never see the cursor's format.

Every check is strict: anything that is not exactly what `encode` writes for that list (bad
base64, bad JSON, extra or missing members, a cursor from another list, a key or ID of the wrong
type) raises core's `InvalidCursor` (400 `invalid-cursor`).
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from app.core.errors import InvalidCursor

Kind = Literal[
    "facilities", "providers", "appointment-types", "provider-schedules", "payers",
    "practice-payers", "note-templates",
]

# The type of each list's sort key: a name (text) or a creation time (timestamptz).
KEY_TYPES: dict[Kind, type[str] | type[datetime]] = {
    "facilities": str,
    "providers": datetime,
    "appointment-types": str,
    "provider-schedules": datetime,
    "payers": str,
    "practice-payers": str,
    "note-templates": str,
}

_VERSION = 1
_MEMBERS = frozenset({"v", "k", "s", "i"})


@dataclass(frozen=True)
class Position:
    """Where a page ended: the last row's sort key and ID. The next page starts after it."""

    kind: Kind
    key: str | datetime
    id: UUID


def encode(position: Position) -> str:
    expected = KEY_TYPES[position.kind]
    if not isinstance(position.key, expected):
        raise TypeError(f"{position.kind} positions have a {expected.__name__} key")
    key = position.key.isoformat() if isinstance(position.key, datetime) else position.key
    payload = {"v": _VERSION, "k": position.kind, "s": key, "i": str(position.id)}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode(cursor: str, kind: Kind) -> Position:
    expected = KEY_TYPES[kind]
    try:
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        payload = json.loads(raw.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, ValueError, RecursionError):
        raise InvalidCursor() from None
    if not isinstance(payload, dict) or payload.keys() != _MEMBERS:
        raise InvalidCursor()
    version, found_kind, key, row_id = payload["v"], payload["k"], payload["s"], payload["i"]
    if type(version) is not int or version != _VERSION or found_kind != kind:
        raise InvalidCursor()
    if not isinstance(key, str) or not isinstance(row_id, str):
        raise InvalidCursor()
    try:
        parsed_id = UUID(row_id)
    except ValueError:
        raise InvalidCursor() from None
    if str(parsed_id) != row_id:  # only the canonical lowercase form encode() writes
        raise InvalidCursor()
    if expected is datetime:
        try:
            at = datetime.fromisoformat(key)
        except ValueError:
            raise InvalidCursor() from None
        if at.tzinfo is None:
            raise InvalidCursor()
        return Position(kind=kind, key=at, id=parsed_id)
    return Position(kind=kind, key=key, id=parsed_id)
