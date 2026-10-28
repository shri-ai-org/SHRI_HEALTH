"""An in-memory InsuranceRepository over the fakes' World (fakes.py), for the API tests that need
no database. test_insurance_live.py runs the same operations against the real tables.
Synthetic data only."""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from app.core.errors import NotFound

from .. import schemas
from ..repository import Versioned
from .fakes import World, _Consent, _Coverage


class FakeInsuranceRepository:
    def __init__(self, world: World) -> None:
        self.world = world

    def _coverage(self, coverage_id: UUID, c: _Coverage) -> Versioned[schemas.Coverage]:
        d = c.data
        group = next((k for k in d.classes if k.type == "group"), None)
        plan = next((k for k in d.classes if k.type == "plan"), None)
        payer_name = self.world.payers.get(d.payer_id, ("", True))[0] or None
        return Versioned(schemas.Coverage(
            id=coverage_id, patient_id=d.beneficiary_patient_id, order=d.order or 1,
            payer_id=d.payer_id, payer_name=payer_name, member_id=d.member_id or "",
            subscriber_id=d.subscriber_id, group_number=group.value if group else None,
            group_name=group.name if group else None, plan_name=plan.value if plan else None,
            relationship_to_subscriber=cast(schemas.Relationship, d.relationship_code or "self"),
            subscriber_related_person_id=d.subscriber_related_person_id,
            start_date=d.period_start, end_date=d.period_end,
            status=cast(Any, d.status), created_at=c.created_at, updated_at=c.created_at),
            c.version)

    async def list_coverages(self, db: Any, patient_id: UUID, *, limit: int, offset: int
                             ) -> list[schemas.Coverage]:
        mine = sorted(((i, c) for i, c in self.world.coverages_of(db).items()
                       if c.data.beneficiary_patient_id == patient_id),
                      key=lambda ic: ic[1].data.order or 99)
        return [self._coverage(i, c).value for i, c in mine][offset:offset + limit]

    async def get_coverage(self, db: Any, patient_id: UUID, coverage_id: UUID
                           ) -> Versioned[schemas.Coverage]:
        found = self.world.coverages_of(db).get(coverage_id)
        if found is None or found.data.beneficiary_patient_id != patient_id:
            raise NotFound()
        return self._coverage(coverage_id, found)

    async def active_orders(self, db: Any, patient_id: UUID, exclude: UUID | None = None
                            ) -> set[int]:
        return {c.data.order for i, c in self.world.coverages_of(db).items()
                if c.data.beneficiary_patient_id == patient_id and c.data.status == "active"
                and c.data.order is not None and i != exclude}

    async def payer_usable(self, db: Any, payer_id: UUID) -> bool | None:
        found = self.world.payers.get(payer_id)
        return None if found is None else found[1]

    async def is_related_person(self, db: Any, patient_id: UUID, related_person_id: UUID
                                ) -> bool:
        found = self.world.related_of(db).get(related_person_id)
        return found is not None and found.data.patient_id == patient_id

    async def file_ready(self, db: Any, file_id: UUID, purpose: str) -> bool:
        return purpose == "document" and file_id in self.world.clean_files

    def _consent(self, consent_id: UUID, c: _Consent) -> Versioned[schemas.Consent]:
        d = c.data
        return Versioned(schemas.Consent(
            id=consent_id, patient_id=d.patient_id, kind=cast(schemas.ConsentKind, d.kind),
            decision=cast(Any, d.provision_type or "permit"),
            signature_method=cast(Any, d.signature_method), signed_at=d.date_time,
            policy_version=d.policy_version, grantor_related_person_id=d.grantor_related_person_id,
            signed_form_file_id=d.source_attachment_binary_object_id,
            status=cast(Any, d.status), created_at=c.created_at), c.version)

    async def list_consents(self, db: Any, patient_id: UUID, kind: str | None, *, limit: int,
                            offset: int) -> list[schemas.Consent]:
        mine = [self._consent(i, c).value for i, c in self.world.consents_of(db).items()
                if c.data.patient_id == patient_id and (kind is None or c.data.kind == kind)]
        mine.sort(key=lambda c: c.signed_at, reverse=True)
        return mine[offset:offset + limit]

    async def get_consent(self, db: Any, patient_id: UUID, consent_id: UUID
                          ) -> Versioned[schemas.Consent]:
        found = self.world.consents_of(db).get(consent_id)
        if found is None or found.data.patient_id != patient_id:
            raise NotFound()
        return self._consent(consent_id, found)
