"""Reads for coverages and consents (patients.yaml; batch 1 plan, PR-2).

As in repository.py: plain SQL under the request's session, so forced row-level security limits
every query to the caller's clinic, and writes go through Anand's FHIR write helpers. Contract
field to column as in ``backend/app/db/docs/contract_mapping.yaml`` ("Coverage (insurance)",
"Consents"; #87). The ETag is the resource's ``meta_version_id``; ``updatedAt`` is
``meta_last_updated``, which moves with child rows too.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound

from . import schemas
from .repository import Versioned


class InsuranceRepository(Protocol):
    async def list_coverages(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                             offset: int) -> list[schemas.Coverage]: ...

    async def get_coverage(self, db: AsyncSession, patient_id: UUID, coverage_id: UUID
                           ) -> Versioned[schemas.Coverage]: ...

    async def active_orders(self, db: AsyncSession, patient_id: UUID,
                            exclude: UUID | None = None) -> set[int]:
        """The orders the patient's active coverages hold (the database keeps them unique)."""
        ...

    async def payer_usable(self, db: AsyncSession, payer_id: UUID) -> bool | None:
        """None: no such payer. False: the payer, or the practice's use of it, is inactive."""
        ...

    async def is_related_person(self, db: AsyncSession, patient_id: UUID,
                                related_person_id: UUID) -> bool: ...

    async def file_ready(self, db: AsyncSession, file_id: UUID) -> bool:
        """A file of this clinic that scanned clean."""
        ...

    async def list_consents(self, db: AsyncSession, patient_id: UUID, kind: str | None, *,
                            limit: int, offset: int) -> list[schemas.Consent]: ...

    async def get_consent(self, db: AsyncSession, patient_id: UUID, consent_id: UUID
                          ) -> Versioned[schemas.Consent]: ...


_COVERAGES = text("""
SELECT c.id, c.beneficiary_patient_id, c.status, c."order", c.subscriber_id,
       c.subscriber_related_person_id, c.relationship_code, c.period_start, c.period_end,
       c.meta_version_id, c.created_at, c.meta_last_updated,
       cp.payer_id, py.name AS payer_name
FROM clinical.coverage c
LEFT JOIN clinical.coverage_payor cp ON cp.coverage_id = c.id
LEFT JOIN admin.payer py ON py.id = cp.payer_id
WHERE c.beneficiary_patient_id = :patient_id AND (CAST(:id AS uuid) IS NULL OR c.id = :id)
ORDER BY c."order" NULLS LAST, c.created_at, c.id LIMIT :limit OFFSET :offset
""")
_MEMBER_IDS = text("""
SELECT coverage_id, value FROM clinical.identifier
WHERE coverage_id = ANY(:ids) AND type_code = 'MB' ORDER BY created_at, id
""")
_CLASSES = text("""
SELECT coverage_id, type, value, name FROM clinical.coverage_class
WHERE coverage_id = ANY(:ids) ORDER BY created_at, id
""")
_CARD_IMAGES = text("""
SELECT coverage_id, side, binary_object_id, created_at FROM clinical.coverage_card_image
WHERE coverage_id = ANY(:ids) ORDER BY created_at, id
""")
_ACTIVE_ORDERS = text("""
SELECT "order" FROM clinical.coverage
WHERE beneficiary_patient_id = :patient_id AND status = 'active' AND "order" IS NOT NULL
  AND (CAST(:exclude AS uuid) IS NULL OR id <> :exclude)
""")
_PAYER = text("""
SELECT py.is_active, pp.is_active AS practice_active
FROM admin.payer py LEFT JOIN admin.practice_payer pp ON pp.payer_id = py.id
WHERE py.id = :id
""")
_RELATED = text("""
SELECT 1 FROM clinical.related_person WHERE id = :id AND patient_id = :patient_id
""")
_FILE = text("SELECT scan_status FROM admin.binary_object WHERE id = :id")
_CONSENTS = text("""
SELECT id, patient_id, status, ext_kind, provision_type, ext_signature_method, date_time,
       ext_policy_version, ext_grantor_related_person_id, source_attachment_binary_object_id,
       meta_version_id, created_at
FROM clinical.consent
WHERE patient_id = :patient_id AND (CAST(:id AS uuid) IS NULL OR id = :id)
  AND (CAST(:kind AS text) IS NULL OR ext_kind = :kind)
ORDER BY date_time DESC NULLS LAST, created_at DESC, id LIMIT :limit OFFSET :offset
""")


def _coverage(row: Mapping[str, Any], members: Sequence[Mapping[str, Any]],
              classes: Sequence[Mapping[str, Any]], images: Sequence[Mapping[str, Any]]
              ) -> schemas.Coverage:
    mine = row["id"]
    group = next((c for c in classes if c["coverage_id"] == mine and c["type"] == "group"), None)
    plan = next((c for c in classes if c["coverage_id"] == mine and c["type"] == "plan"), None)
    member = next((m["value"] for m in members if m["coverage_id"] == mine), "")
    return schemas.Coverage(
        id=mine, patient_id=row["beneficiary_patient_id"], order=row["order"],
        payer_id=row["payer_id"], payer_name=row["payer_name"], member_id=member,
        subscriber_id=row["subscriber_id"],
        group_number=group["value"] if group else None, group_name=group["name"] if group else None,
        plan_name=plan["value"] if plan else None,
        relationship_to_subscriber=row["relationship_code"] or "self",
        subscriber_related_person_id=row["subscriber_related_person_id"],
        start_date=row["period_start"], end_date=row["period_end"], status=row["status"],
        card_images=[schemas.CoverageCardImage(side=i["side"], file_id=i["binary_object_id"],
                                               added_at=i["created_at"])
                     for i in images if i["coverage_id"] == mine],
        created_at=row["created_at"], updated_at=row["meta_last_updated"])


def _consent(row: Mapping[str, Any]) -> schemas.Consent:
    return schemas.Consent(
        id=row["id"], patient_id=row["patient_id"], kind=row["ext_kind"],
        decision=row["provision_type"] or "permit", signature_method=row["ext_signature_method"],
        signed_at=row["date_time"], policy_version=row["ext_policy_version"],
        grantor_related_person_id=row["ext_grantor_related_person_id"],
        signed_form_file_id=row["source_attachment_binary_object_id"], status=row["status"],
        created_at=row["created_at"])


class SqlInsuranceRepository:
    async def _coverages(self, db: AsyncSession, patient_id: UUID, coverage_id: UUID | None, *,
                         limit: int, offset: int) -> list[Versioned[schemas.Coverage]]:
        rows = [dict(r) for r in (await db.execute(_COVERAGES, {
            "patient_id": patient_id, "id": coverage_id, "limit": limit, "offset": offset,
        })).mappings()]
        ids = [r["id"] for r in rows]
        members = [dict(r) for r in (await db.execute(_MEMBER_IDS, {"ids": ids})).mappings()]
        classes = [dict(r) for r in (await db.execute(_CLASSES, {"ids": ids})).mappings()]
        images = [dict(r) for r in (await db.execute(_CARD_IMAGES, {"ids": ids})).mappings()]
        return [Versioned(_coverage(r, members, classes, images), r["meta_version_id"])
                for r in rows]

    async def list_coverages(self, db: AsyncSession, patient_id: UUID, *, limit: int,
                             offset: int) -> list[schemas.Coverage]:
        found = await self._coverages(db, patient_id, None, limit=limit, offset=offset)
        return [v.value for v in found]

    async def get_coverage(self, db: AsyncSession, patient_id: UUID, coverage_id: UUID
                           ) -> Versioned[schemas.Coverage]:
        found = await self._coverages(db, patient_id, coverage_id, limit=1, offset=0)
        if not found:
            raise NotFound()
        return found[0]

    async def active_orders(self, db: AsyncSession, patient_id: UUID,
                            exclude: UUID | None = None) -> set[int]:
        rows = await db.execute(_ACTIVE_ORDERS, {"patient_id": patient_id, "exclude": exclude})
        return {int(r[0]) for r in rows}

    async def payer_usable(self, db: AsyncSession, payer_id: UUID) -> bool | None:
        row = (await db.execute(_PAYER, {"id": payer_id})).mappings().first()
        if row is None:
            return None
        return bool(row["is_active"]) and row["practice_active"] is not False

    async def is_related_person(self, db: AsyncSession, patient_id: UUID,
                                related_person_id: UUID) -> bool:
        found = await db.execute(_RELATED, {"id": related_person_id, "patient_id": patient_id})
        return found.first() is not None

    async def file_ready(self, db: AsyncSession, file_id: UUID) -> bool:
        status = (await db.execute(_FILE, {"id": file_id})).scalar_one_or_none()
        return status == "clean"

    async def list_consents(self, db: AsyncSession, patient_id: UUID, kind: str | None, *,
                            limit: int, offset: int) -> list[schemas.Consent]:
        rows = (await db.execute(_CONSENTS, {"patient_id": patient_id, "id": None, "kind": kind,
                                             "limit": limit, "offset": offset})).mappings()
        return [_consent(dict(r)) for r in rows]

    async def get_consent(self, db: AsyncSession, patient_id: UUID, consent_id: UUID
                          ) -> Versioned[schemas.Consent]:
        row = (await db.execute(_CONSENTS, {"patient_id": patient_id, "id": consent_id,
                                            "kind": None, "limit": 1, "offset": 0}
                                )).mappings().first()
        if row is None:
            raise NotFound()
        return Versioned(_consent(dict(row)), row["meta_version_id"])
