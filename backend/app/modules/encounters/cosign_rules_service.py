"""Co-signature rules (inventory #87-89, #251; FRS FR-ENC-01): who co-signs an NP's or PA's
notes, prescriptions or orders, optionally in one state and within a number of days. A rule ends
with ``effectiveTo``; nothing is deleted. The ETag is a digest of the row (the table has no
version column), so PATCH with a stale one gets 412."""

from __future__ import annotations

import hashlib
from datetime import date
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import NotFound, PreconditionFailed, PreconditionRequired, field_error

from . import cosign_rules_schemas as cs
from .cosign_rules_repository import RuleRow, SqlCosignRuleRepository
from .service import business_rule, decode_cursor, page


def etag(row: RuleRow) -> str:
    stamp = f"{row.id}:{row.updated_at.isoformat()}"
    return f'"{hashlib.sha256(stamp.encode()).hexdigest()[:20]}"'


def out(row: RuleRow) -> cs.CosignRule:
    return cs.CosignRule(
        id=row.id, supervisee_provider_id=row.supervisee_practitioner_id,
        supervising_provider_id=row.supervising_practitioner_id, state=row.state,
        applies_to_notes=row.applies_to_notes,
        applies_to_prescriptions=row.applies_to_prescriptions,
        applies_to_orders=row.applies_to_orders, cosign_within_days=row.cosign_within_days,
        effective_from=row.effective_from, effective_to=row.effective_to,
        created_at=row.created_at, updated_at=row.updated_at)


async def listed(db: AsyncSession, repo: SqlCosignRuleRepository, *, provider_id: UUID | None,
                 active_on: date | None, limit: int, cursor: str | None
                 ) -> tuple[list[cs.CosignRule], str | None]:
    offset = decode_cursor(cursor)
    rows = await repo.rows(db, provider_id=provider_id, active_on=active_on, limit=limit,
                           offset=offset)
    items, next_cursor = page(rows, limit, offset)
    return [out(r) for r in items], next_cursor


async def one(db: AsyncSession, repo: SqlCosignRuleRepository, rule_id: UUID
              ) -> tuple[cs.CosignRule, str]:
    row = await repo.get(db, rule_id)
    if row is None:
        raise NotFound()
    return out(row), etag(row)


async def _check(db: AsyncSession, repo: SqlCosignRuleRepository, *, supervisee: UUID,
                 supervising: UUID, state: str | None, notes: bool, rx: bool, orders: bool,
                 start: date, end: date | None, skip: UUID | None) -> None:
    """The contract's business rules, every one that fails named at once."""
    errors = []
    if supervisee == supervising:
        errors.append(field_error("body", "/supervisingProviderId", "conflicting-fields"))
    if not (notes or rx or orders):
        errors.append(field_error("body", "/appliesToNotes", "required"))
    if end is not None and end < start:
        errors.append(field_error("body", "/effectiveTo", "out-of-range"))
    active = await repo.active_providers(db, [supervisee, supervising])
    if supervisee not in active and skip is None:
        errors.append(field_error("body", "/superviseeProviderId", "invalid-reference"))
    if supervising not in active:
        errors.append(field_error("body", "/supervisingProviderId", "invalid-reference"))
    if not errors and await repo.overlaps(db, supervisee=supervisee, state=state, start=start,
                                          end=end, skip=skip):
        errors.append(field_error("body", "/effectiveFrom", "conflicting-fields"))
    if errors:
        raise business_rule(errors)


async def create(db: AsyncSession, repo: SqlCosignRuleRepository, user: CurrentUser,
                 body: cs.CosignRuleCreate) -> tuple[cs.CosignRule, str]:
    await repo.lock_supervisee(db, body.supervisee_provider_id)
    await _check(db, repo, supervisee=body.supervisee_provider_id,
                 supervising=body.supervising_provider_id, state=body.state,
                 notes=body.applies_to_notes, rx=body.applies_to_prescriptions,
                 orders=body.applies_to_orders, start=body.effective_from,
                 end=body.effective_to, skip=None)
    rule_id = await repo.insert(db, {
        "supervisee": body.supervisee_provider_id, "supervising": body.supervising_provider_id,
        "state": body.state, "notes": body.applies_to_notes, "rx": body.applies_to_prescriptions,
        "orders": body.applies_to_orders, "days": body.cosign_within_days,
        "from": body.effective_from, "to": body.effective_to, "user": user.id})
    await db.commit()
    return await one(db, repo, rule_id)


def _strong(header: str | None) -> str:
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if not (value.startswith('"') and value.endswith('"')):
        raise PreconditionFailed()
    return value


async def update(db: AsyncSession, repo: SqlCosignRuleRepository, user: CurrentUser,
                 rule_id: UUID, patch: cs.CosignRulePatch, if_match: str | None
                 ) -> tuple[cs.CosignRule, str]:
    wanted = _strong(if_match)
    found = await repo.get(db, rule_id)
    if found is None:
        raise NotFound()
    await repo.lock_supervisee(db, found.supervisee_practitioner_id)
    current = await repo.get(db, rule_id, lock=True)
    if current is None:
        raise NotFound()
    if etag(current) != wanted:
        raise PreconditionFailed(headers={"ETag": etag(current)})
    sent = patch.model_fields_set

    def merged(field: str, current_value: Any) -> Any:
        return getattr(patch, field) if field in sent else current_value

    supervising = merged("supervising_provider_id", current.supervising_practitioner_id)
    if supervising is None:  # required: null can't clear it
        raise business_rule([field_error("body", "/supervisingProviderId", "required")])
    values = {
        "id": rule_id, "supervising": supervising,
        "notes": merged("applies_to_notes", current.applies_to_notes),
        "rx": merged("applies_to_prescriptions", current.applies_to_prescriptions),
        "orders": merged("applies_to_orders", current.applies_to_orders),
        "days": merged("cosign_within_days", current.cosign_within_days),
        "to": merged("effective_to", current.effective_to), "user": user.id}
    for flag in ("notes", "rx", "orders"):
        if values[flag] is None:
            raise business_rule([field_error("body", "/appliesToNotes", "required")])
    await _check(db, repo, supervisee=current.supervisee_practitioner_id,
                 supervising=values["supervising"], state=current.state, notes=values["notes"],
                 rx=values["rx"], orders=values["orders"], start=current.effective_from,
                 end=values["to"], skip=rule_id)
    await repo.update(db, values)
    await db.commit()
    return await one(db, repo, rule_id)
