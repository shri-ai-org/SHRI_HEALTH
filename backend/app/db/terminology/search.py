"""Code search over admin.concept (searchCodes, ``GET /codes``; demo steps 8 and 9).

Best match first, in four classes, each by word similarity to the query, then by code:
  0  the code itself (``E11.9``, typed with or without its dot, any case);
  1  codes that start with the query;
  2  names that contain every word of the query, in any order (``diabetes type 2``);
  3  names close to the query word by word (pg_trgm's ``<%``), so a typo still finds them.
The name search uses the trigram index on ``concept.display``. Only active concepts; for
ICD-10-CM, ``billable_only`` leaves out header codes. For RxNorm only the products a prescriber
can pick (SCD, SBD, GPCK, BPCK), each with its drug details from ``concept_property``.

A page ends at a ``Position`` (class, similarity, code); the next page starts after it.
Reference data, not patient data: nothing here is audited.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems

SYSTEMS = {"icd-10-cm": systems.ICD10CM, "snomed-ct": systems.SNOMED, "loinc": systems.LOINC,
           "rxnorm": systems.RXNORM, "cpt": systems.CPT, "hcpcs": systems.HCPCS,
           "cvx": systems.CVX}
PRODUCTS = ("SCD", "SBD", "GPCK", "BPCK")


@dataclass(frozen=True)
class Position:
    rank: int
    similarity: float
    code: str


@dataclass(frozen=True)
class Ingredient:
    rxcui: str
    name: str


@dataclass(frozen=True)
class Drug:
    strength: str | None
    dose_form: str | None
    route: str | None
    ingredients: tuple[Ingredient, ...]
    brand_name: str | None
    schedule: str | None


@dataclass(frozen=True)
class Match:
    system: str
    code: str
    display: str
    billable: bool | None
    drug: Drug | None
    position: Position


_SEARCH = text("""
WITH found AS (
  SELECT c.id, c.code, c.display, c.is_billable,
         CASE WHEN replace(upper(c.code), '.', '') = :code_q THEN 0
              WHEN replace(upper(c.code), '.', '') LIKE :code_prefix THEN 1
              WHEN c.display ILIKE ALL (CAST(:words AS text[])) THEN 2
              ELSE 3 END AS rank,
         CAST(word_similarity(:q, c.display) AS float8) AS similarity
  FROM admin.concept c
  WHERE c.code_system_id = (SELECT id FROM admin.code_system WHERE uri = :system)
    AND c.is_active
    AND (NOT :billable_only OR c.is_billable)
    AND (NOT :products_only OR EXISTS (
          SELECT 1 FROM admin.concept_property p WHERE p.concept_id = c.id
          AND p.property = 'tty' AND p.value = ANY (CAST(:products AS text[]))))
    AND (replace(upper(c.code), '.', '') LIKE :code_prefix
         OR c.display ILIKE ALL (CAST(:words AS text[]))
         OR :q <% c.display)
)
SELECT id, code, display, is_billable, rank, similarity FROM found
WHERE CAST(:after_rank AS int) IS NULL
   OR (rank, -similarity, code) > (CAST(:after_rank AS int), -CAST(:after_sim AS float8),
                                   CAST(:after_code AS text))
ORDER BY rank, similarity DESC, code
LIMIT :limit
""")

_DRUGS = text("""
SELECT p.concept_id, p.property, p.value, i.display AS ingredient_name
FROM admin.concept_property p
LEFT JOIN admin.concept i ON p.property = 'ingredient' AND i.code = p.value
  AND i.code_system_id = (SELECT id FROM admin.code_system WHERE uri = :system)
WHERE p.concept_id = ANY (CAST(:ids AS uuid[]))
  AND p.property IN ('strength', 'dose_form', 'route', 'ingredient', 'brand_name', 'dea_schedule')
ORDER BY p.concept_id, p.property, p.value
""")


def _like(value: str) -> str:
    return re.sub(r"([\\%_])", r"\\\1", value)


async def _drugs(db: AsyncSession, ids: list[UUID]) -> dict[UUID, Drug]:
    found: dict[UUID, dict[str, list[tuple[str, str | None]]]] = {}
    for row in await db.execute(_DRUGS, {"ids": ids, "system": systems.RXNORM}):
        found.setdefault(row.concept_id, {}).setdefault(row.property, []).append(
            (row.value, row.ingredient_name))

    def one(props: dict[str, list[tuple[str, str | None]]], name: str) -> str | None:
        values = props.get(name)
        return values[0][0] if values else None

    return {cid: Drug(
        strength=one(props, "strength"), dose_form=one(props, "dose_form"),
        route=one(props, "route"),
        ingredients=tuple(Ingredient(rxcui, name or rxcui)
                          for rxcui, name in props.get("ingredient", [])),
        brand_name=one(props, "brand_name"), schedule=one(props, "dea_schedule"))
        for cid, props in found.items()}


async def search(db: AsyncSession, system: str, q: str, *, billable_only: bool = False,
                 after: Position | None = None, limit: int = 20
                 ) -> tuple[list[Match], Position | None]:
    """One page of matches, best first, and where the next page starts (None on the last)."""
    uri = SYSTEMS[system]
    query = " ".join(q.split())
    code_q = query.upper().replace(".", "")
    words = [f"%{_like(w)}%" for w in query.split()]
    rows = (await db.execute(_SEARCH, {
        "system": uri, "q": query, "code_q": code_q, "code_prefix": f"{_like(code_q)}%",
        "words": words, "billable_only": billable_only and system == "icd-10-cm",
        "products_only": system == "rxnorm", "products": list(PRODUCTS),
        "after_rank": after.rank if after else None,
        "after_sim": after.similarity if after else None,
        "after_code": after.code if after else None, "limit": limit + 1})).all()
    page, more = rows[:limit], len(rows) > limit
    drugs = await _drugs(db, [r.id for r in page]) if system == "rxnorm" and page else {}
    matches = [Match(system=uri, code=r.code, display=r.display,
                     billable=r.is_billable if system == "icd-10-cm" else None,
                     drug=drugs.get(r.id), position=Position(r.rank, r.similarity, r.code))
               for r in page]
    return matches, (matches[-1].position if more else None)
