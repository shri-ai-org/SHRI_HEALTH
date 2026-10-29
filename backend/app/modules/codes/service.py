"""searchCodes' rules: the cursor, and turning the terminology search's matches into the
contract's shape. The search itself is app.db.terminology.search.

The cursor is base64url (no padding) of {"v", "f", "r", "s", "c"}: a fingerprint of the search
(system, words, billableOnly), so a cursor only continues the search it came from, and the last
match's class, similarity and code. Anything else is core's ``InvalidCursor`` (400). Codes are
reference data, not patient data, so the cursor is not encrypted (as practice setup's, until
core's T22 cursor lands).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidCursor
from app.db.terminology import search as terms

from . import schemas

_VERSION = 1
_MEMBERS = frozenset({"v", "f", "r", "s", "c"})


def fingerprint(system: str, q: str, billable_only: bool) -> str:
    words = " ".join(q.split()).lower()
    return hashlib.sha256(f"{system}\n{words}\n{billable_only}".encode()).hexdigest()[:16]


def encode(position: terms.Position, finger: str) -> str:
    payload = {"v": _VERSION, "f": finger, "r": position.rank, "s": position.similarity,
               "c": position.code}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode(cursor: str, finger: str) -> terms.Position:
    try:
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        payload = json.loads(raw.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, ValueError, RecursionError):
        raise InvalidCursor() from None
    if (not isinstance(payload, dict) or payload.keys() != _MEMBERS
            or payload["v"] != _VERSION or payload["f"] != finger
            or type(payload["r"]) is not int or not 0 <= payload["r"] <= 3
            or type(payload["s"]) not in (int, float) or not isinstance(payload["c"], str)):
        raise InvalidCursor()
    return terms.Position(payload["r"], float(payload["s"]), payload["c"])


def _drug(drug: terms.Drug | None) -> schemas.DrugDetails | None:
    if drug is None or not drug.ingredients:
        return None
    schedule = drug.schedule if drug.schedule in ("CII", "CIII", "CIV", "CV") else None
    return schemas.DrugDetails(
        strength=drug.strength, dose_form=drug.dose_form, route=drug.route,
        ingredients=[schemas.DrugIngredient(rxcui=i.rxcui, name=i.name)
                     for i in drug.ingredients],
        brand_name=drug.brand_name, controlled_schedule=schedule)


async def search_codes(db: AsyncSession, *, system: schemas.CodeSystem, q: str,
                       billable_only: bool, cursor_value: str | None, limit: int
                       ) -> schemas.CodeMatchList:
    finger = fingerprint(system, q, billable_only)
    after = decode(cursor_value, finger) if cursor_value else None
    matches, more = await terms.search(db, system, q, billable_only=billable_only,
                                       after=after, limit=limit)
    return schemas.CodeMatchList(
        items=[schemas.CodeMatch(system=m.system, code=m.code, display=m.display,
                                 billable=m.billable, drug=_drug(m.drug)) for m in matches],
        next_cursor=encode(more, finger) if more else None)
