"""Co-signature rules (admin.cosign_rule, Anand's schema): reads and writes in the request's
transaction under row-level security, so another clinic's rules are simply not found. The notes
service reads the same table when a note is signed (notes_repository._COSIGNER)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class RuleRow:
    id: UUID
    supervisee_practitioner_id: UUID
    supervising_practitioner_id: UUID
    state: str | None
    applies_to_notes: bool
    applies_to_prescriptions: bool
    applies_to_orders: bool
    cosign_within_days: int | None
    effective_from: date
    effective_to: date | None
    created_at: datetime
    updated_at: datetime


_COLUMNS = """id, supervisee_practitioner_id, supervising_practitioner_id, state, applies_to_notes,
       applies_to_prescriptions, applies_to_orders, cosign_within_days, effective_from,
       effective_to, created_at, updated_at"""
_LIST = text(f"""
SELECT {_COLUMNS} FROM admin.cosign_rule
WHERE (CAST(:provider AS uuid) IS NULL OR :provider IN (supervisee_practitioner_id,
                                                        supervising_practitioner_id))
  AND (CAST(:on AS date) IS NULL OR (effective_from <= :on
                                    AND (effective_to IS NULL OR effective_to >= :on)))
ORDER BY effective_from DESC, id
LIMIT :limit OFFSET :offset
""")  # noqa: S608 (a fixed column list, no input)
_ONE = text(f"SELECT {_COLUMNS} FROM admin.cosign_rule WHERE id = :id")  # noqa: S608
_ONE_LOCKED = text(f"SELECT {_COLUMNS} FROM admin.cosign_rule WHERE id = :id FOR UPDATE")  # noqa: S608
# One writer per supervisee at a time, so the overlap check and the write are one step.
_LOCK = text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))")
_OVERLAP = text("""
SELECT 1 FROM admin.cosign_rule
WHERE supervisee_practitioner_id = :supervisee AND state IS NOT DISTINCT FROM :state
  AND id IS DISTINCT FROM CAST(:skip AS uuid)
  AND effective_from <= coalesce(CAST(:to AS date), 'infinity'::date)
  AND coalesce(effective_to, 'infinity'::date) >= :from
LIMIT 1
""")
_PROVIDERS = text("SELECT id FROM clinical.practitioner WHERE id = ANY(:ids) AND active")
_INSERT = text("""
INSERT INTO admin.cosign_rule (id, tenant_id, supervisee_practitioner_id,
    supervising_practitioner_id, state, applies_to_notes, applies_to_prescriptions,
    applies_to_orders, cosign_within_days, effective_from, effective_to, created_by_user_id,
    updated_by_user_id)
SELECT gen_random_uuid(), p.tenant_id, :supervisee, :supervising, :state, :notes, :rx, :orders,
       :days, :from, :to, :user, :user
FROM clinical.practitioner p WHERE p.id = :supervisee
RETURNING id
""")
_UPDATE = text("""
UPDATE admin.cosign_rule SET supervising_practitioner_id = :supervising, applies_to_notes = :notes,
    applies_to_prescriptions = :rx, applies_to_orders = :orders, cosign_within_days = :days,
    effective_to = :to, updated_at = now(), updated_by_user_id = :user
WHERE id = :id
""")


class SqlCosignRuleRepository:
    async def rows(self, db: AsyncSession, *, provider_id: UUID | None, active_on: date | None,
                   limit: int, offset: int) -> list[RuleRow]:
        found = await db.execute(_LIST, {"provider": provider_id, "on": active_on,
                                         "limit": limit + 1, "offset": offset})
        return [RuleRow(**dict(r)) for r in found.mappings()]

    async def get(self, db: AsyncSession, rule_id: UUID, *, lock: bool = False
                  ) -> RuleRow | None:
        found = (await db.execute(_ONE_LOCKED if lock else _ONE, {"id": rule_id})
                 ).mappings().first()
        return RuleRow(**dict(found)) if found else None

    async def lock_supervisee(self, db: AsyncSession, supervisee: UUID) -> None:
        await db.execute(_LOCK, {"key": f"cosign-rule:{supervisee}"})

    async def overlaps(self, db: AsyncSession, *, supervisee: UUID, state: str | None,
                       start: date, end: date | None, skip: UUID | None = None) -> bool:
        found = await db.execute(_OVERLAP, {"supervisee": supervisee, "state": state,
                                            "from": start, "to": end, "skip": skip})
        return found.first() is not None

    async def active_providers(self, db: AsyncSession, ids: list[UUID]) -> set[UUID]:
        return {r[0] for r in await db.execute(_PROVIDERS, {"ids": ids})}

    async def insert(self, db: AsyncSession, values: dict[str, Any]) -> UUID:
        created: UUID = (await db.execute(_INSERT, values)).scalar_one()
        return created

    async def update(self, db: AsyncSession, values: dict[str, Any]) -> None:
        await db.execute(_UPDATE, values)
