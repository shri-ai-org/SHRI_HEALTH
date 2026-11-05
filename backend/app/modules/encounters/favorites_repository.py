"""The current user's favorites (admin.user_favorite, one row per favorite with the column that
matches its kind; Anand's schema). Reads and the whole-list replace, in the request's transaction,
under row-level security: another clinic's targets are simply not found."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import systems


@dataclass(frozen=True)
class FavoriteRow:
    id: UUID
    kind: str
    sequence: int
    target_id: UUID | None
    diagnosis_system: str | None
    diagnosis_code: str | None
    diagnosis_display: str | None
    label: str | None
    updated_at: datetime


@dataclass(frozen=True)
class NewFavorite:
    kind: str
    sequence: int
    target_id: UUID | None
    diagnosis_code: str | None
    diagnosis_display: str | None


#: The column each kind points with (admin.user_favorite's kind_matches_target check).
TARGET_COLUMN = {"note-template": "note_template_id", "order": "compendium_test_id",
                 "order-set": "order_set_id", "prescription": "prescription_favorite_id",
                 "phrase": "smart_phrase_id"}

_ROWS = text("""
SELECT f.id, f.kind, f.sequence, f.diagnosis_system, f.diagnosis_code, f.diagnosis_display,
       coalesce(f.note_template_id, f.compendium_test_id, f.order_set_id,
                f.prescription_favorite_id, f.smart_phrase_id) AS target_id,
       coalesce(t.name, ct.test_name, os.name, pf.name, sp.abbreviation,
                f.diagnosis_display) AS label,
       f.updated_at
FROM admin.user_favorite f
LEFT JOIN admin.note_template t ON t.id = f.note_template_id
LEFT JOIN admin.compendium_test ct ON ct.id = f.compendium_test_id
LEFT JOIN admin.order_set os ON os.id = f.order_set_id
LEFT JOIN admin.prescription_favorite pf ON pf.id = f.prescription_favorite_id
LEFT JOIN admin.smart_phrase sp ON sp.id = f.smart_phrase_id
WHERE f.user_id = :user
ORDER BY f.kind, f.sequence, f.id
""")
# One writer per user's list at a time, so the If-Match check and the replace are one step.
_LOCK = text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))")
_CLEAR = text("DELETE FROM admin.user_favorite WHERE user_id = :user")
# A target the user may pick: in the clinic (RLS), active where the table says so, and either
# the practice's (no owner) or the user's own.
_TARGETS = {
    "note-template": "SELECT id FROM admin.note_template WHERE id = ANY(:ids) AND is_active "
                     "AND (owner_user_id IS NULL OR owner_user_id = :user)",
    "order": "SELECT id FROM admin.compendium_test WHERE id = ANY(:ids) AND is_active",
    "order-set": "SELECT id FROM admin.order_set WHERE id = ANY(:ids) AND is_active "
                 "AND (owner_user_id IS NULL OR owner_user_id = :user)",
    "prescription": "SELECT id FROM admin.prescription_favorite WHERE id = ANY(:ids) "
                    "AND (owner_user_id IS NULL OR owner_user_id = :user)",
    "phrase": "SELECT id FROM admin.smart_phrase WHERE id = ANY(:ids) "
              "AND (owner_user_id IS NULL OR owner_user_id = :user)",
}
_INSERT = text("""
INSERT INTO admin.user_favorite (id, tenant_id, user_id, kind, sequence, note_template_id,
    compendium_test_id, order_set_id, prescription_favorite_id, smart_phrase_id,
    diagnosis_system, diagnosis_code, diagnosis_display)
SELECT gen_random_uuid(), u.tenant_id, u.id, :kind, :seq, :note_template_id, :compendium_test_id,
       :order_set_id, :prescription_favorite_id, :smart_phrase_id, :dsys, :dcode, :ddisp
FROM admin.app_user u WHERE u.id = :user
""")
_CONCEPTS = text("""
SELECT c.code, c.display, coalesce(c.is_billable, false) AS billable
FROM admin.concept c JOIN admin.code_system s ON s.id = c.code_system_id
WHERE s.uri = :system AND c.code = ANY(:codes) AND c.is_active
""")


class SqlFavoritesRepository:
    async def rows(self, db: AsyncSession, user_id: UUID) -> list[FavoriteRow]:
        found = (await db.execute(_ROWS, {"user": user_id})).mappings().all()
        return [FavoriteRow(**dict(r)) for r in found]

    async def lock(self, db: AsyncSession, user_id: UUID) -> None:
        await db.execute(_LOCK, {"key": f"user-favorites:{user_id}"})

    async def usable_targets(self, db: AsyncSession, kind: str, ids: Sequence[UUID],
                             user_id: UUID) -> set[UUID]:
        if not ids:
            return set()
        found = await db.execute(text(_TARGETS[kind]), {"ids": list(ids), "user": user_id})
        return {r[0] for r in found}

    async def diagnoses(self, db: AsyncSession, codes: Sequence[str]
                        ) -> dict[str, tuple[str, bool]]:
        if not codes:
            return {}
        found = await db.execute(_CONCEPTS, {"system": systems.ICD10CM, "codes": list(codes)})
        return {r.code: (r.display, r.billable) for r in found}

    async def replace(self, db: AsyncSession, user_id: UUID, items: Sequence[NewFavorite]
                      ) -> None:
        await db.execute(_CLEAR, {"user": user_id})
        for item in items:
            values: dict[str, Any] = {"user": user_id, "kind": item.kind, "seq": item.sequence,
                                      **{column: None for column in TARGET_COLUMN.values()},
                                      "dsys": None, "dcode": None, "ddisp": None}
            column = TARGET_COLUMN.get(item.kind)
            if column is None:  # a diagnosis
                values.update(dsys=systems.ICD10CM, dcode=item.diagnosis_code,
                              ddisp=item.diagnosis_display)
            else:
                values[column] = item.target_id
            await db.execute(_INSERT, values)
