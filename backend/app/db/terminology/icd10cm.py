"""ICD-10-CM into admin.concept, from CMS's free release (diagnosis search, demo step 8).

ICD-10-CM is a U.S. government work (CDC's NCHS, published by CMS) in the public domain: no
licence needed (D75). The loader reads the release's order file, ``icd10cm_order_YYYY.txt``
(fixed width, one code per line):

    columns  1-5   order number
             7-13  the code, without its dot
             15    1 for a billable (valid HIPAA) code, 0 for a header
             17-76 the short description
             78-   the long description

Each code is stored with its dot (``E119`` -> ``E11.9``), as FHIR writes ICD-10-CM; the display
is the long description and ``is_billable`` the flag. A re-run of the same release changes
nothing; a code a later release drops is made inactive, never deleted.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import MAPPERS, systems

LICENCE_NOTE = "ICD-10-CM (CDC NCHS, published by CMS): U.S. government work, public domain"
BATCH = 5000
_LINE = re.compile(r"^(\d{5}) ([A-Z0-9]{3,7})\s+([01]) (.{60}) (.+)$")

M = MAPPERS


@dataclass(frozen=True)
class Code:
    code: str  # with its dot
    display: str
    billable: bool


def dotted(code: str) -> str:
    return code if len(code) <= 3 else f"{code[:3]}.{code[3:]}"


def read_order_file(lines: Iterable[str]) -> Iterator[Code]:
    """Every code of the order file; a line in any other shape is an error, not skipped."""
    for number, line in enumerate(lines, start=1):
        line = line.rstrip("\r\n")
        if not line.strip():
            continue
        found = _LINE.match(line)
        if found is None:
            raise ValueError(f"line {number}: not an ICD-10-CM order-file line")
        _, code, flag, short, long = found.groups()
        yield Code(dotted(code), (long.strip() or short.strip())[:500], flag == "1")


def release_year(source: Path) -> int:
    """The fiscal year in the file's name: icd10cm_order_2026.txt is FY2026."""
    found = re.search(r"(20\d{2})", source.name)
    if found is None:
        raise ValueError(f"{source.name}: not a CMS order file (icd10cm_order_YYYY.txt)")
    return int(found.group(1))


def load(db: Session, codes: list[Code], version: date) -> dict[str, int]:
    """Loads the codes in the session's transaction; the caller commits. Returns counts."""
    cs, concept = M["code_system"], M["concept"]
    system_id = db.execute(select(cs.id).where(cs.uri == systems.ICD10CM)).scalar_one()
    db.execute(update(cs).where(cs.id == system_id).values(
        version=version.isoformat(), license_note=LICENCE_NOTE, updated_at=func.now()))
    for i in range(0, len(codes), BATCH):
        stmt = insert(concept).values([
            {"code_system_id": system_id, "code": c.code, "display": c.display,
             "is_billable": c.billable, "is_active": True, "effective_from": version}
            for c in codes[i:i + BATCH]])
        db.execute(stmt.on_conflict_do_update(
            index_elements=[concept.code_system_id, concept.code],
            set_={"display": stmt.excluded.display, "is_billable": stmt.excluded.is_billable,
                  "is_active": True, "effective_from": stmt.excluded.effective_from,
                  "updated_at": func.now()}))
    retired = len(db.execute(update(concept).where(
        concept.code_system_id == system_id, concept.is_active,
        concept.code.not_in([c.code for c in codes])).values(
            is_active=False, updated_at=func.now()).returning(concept.id)).all())
    return {"concepts": len(codes), "billable": sum(c.billable for c in codes),
            "retired": retired}
