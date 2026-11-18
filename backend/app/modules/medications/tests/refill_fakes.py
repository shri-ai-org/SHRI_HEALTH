"""In-memory stand-ins for refill requests (refill_repository.py), on fakes.py's World: the reads
and Anand's two helpers as #424 writes them, a repository whose drafts remember their
``priorPrescription``, core's chart view and the event log. They keep the rules the API relies
on: a clinic sees its own rows; the portal's session sees its own patient's rows and never a
draft; a request takes no note; an answered request refuses another answer
(``InvalidTransition``), a stale version ``StaleVersion``, a decline only a listed reason code
(stored with its words); one open request per prescription (``RefillAlreadyRequested``).
Synthetic data only."""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass, field, replace
from typing import Any
from uuid import UUID, uuid4

from app.core.access import ChartAccess
from app.core.deps import CurrentUser
from app.db import fhir_store as fs

from ..refill_repository import RefillablePrescription, RefillRequestIn, RefillRow
from .fakes import FakeRepository, World


@dataclass
class Refills:
    """The refill requests of every clinic: id → (clinic, row); and each draft's prior."""
    world: World
    rows: dict[UUID, tuple[UUID, RefillRow]] = field(default_factory=dict)
    priors: dict[UUID, UUID] = field(default_factory=dict)  # draft → refilled prescription
    events: list[tuple[str, str, dict[str, Any], dict[str, Any]]] = field(default_factory=list)
    notes: dict[UUID, str | None] = field(default_factory=dict)
    updated_by: dict[UUID, UUID] = field(default_factory=dict)  # request → user

    def add(self, clinic: UUID, patient_id: UUID, prescription_id: UUID, *,
            note: str | None = None, status: str = "active",
            reason: str | None = None) -> UUID:
        """A request as the portal writes it (set-up)."""
        rid, now = uuid4(), self.world.tick()
        self.rows[rid] = (clinic, RefillRow(
            id=rid, patient_id=patient_id, status=status, prescription_id=prescription_id,
            requested_at=now, last_updated=now, version=1, decline_reason=reason,
            display=None, dosage_text=None, facility_id=None, new_prescription_id=None))
        self.notes[rid] = note
        return rid

    def row(self, request_id: UUID) -> RefillRow:
        return self.rows[request_id][1]


def _portal(db: Any) -> bool:
    return getattr(db, "patient_id", None) is not None


class FakeRefills:
    """RefillReads and RefillStore together."""

    def __init__(self, refills: Refills) -> None:
        self.refills = refills
        self.world = refills.world

    def _visible(self, db: Any, clinic: UUID, patient_id: UUID) -> bool:
        if clinic != db.tenant_id:
            return False
        return not _portal(db) or patient_id == db.patient_id

    def _full(self, db: Any, row: RefillRow) -> RefillRow:
        """The row as the SQL reads it: the prescription's words and facility, the draft an
        approval wrote (invisible to the portal while a draft), and the staff-only columns."""
        found = self.world.prescriptions.get(row.prescription_id)
        if found is None:  # set up without one
            return row
        rx, new_id = found[1], None
        if row.status == "completed":
            drafts = sorted((r.created_at, r.id) for _, r in self.world.prescriptions.values()
                            if self.refills.priors.get(r.id) == row.prescription_id
                            and r.created_at >= row.last_updated
                            and not (_portal(db) and r.status == "draft"))
            new_id = drafts[0][1] if drafts else None
        staff = not _portal(db)
        user = self.refills.updated_by.get(row.id) if staff and row.status != "active" else None
        responder = self.world.practitioners.get(user) if user else None
        return replace(row, display=rx.drug.display or rx.drug.text,
                       dosage_text=rx.dosage_text, facility_id=rx.facility_id,
                       new_prescription_id=new_id,
                       note=self.refills.notes.get(row.id) if staff else None,
                       responder_id=responder,
                       responder_name="Dr. Avery Lindqvist MD" if responder else None)

    # ------------------------------------------------------------------------------ reads
    async def prescription(self, db: Any, prescription_id: UUID
                           ) -> RefillablePrescription | None:
        found = self.world.prescriptions.get(prescription_id)
        if found is None or not self._visible(db, found[0], found[1].patient_id):
            return None
        rx = found[1]
        if _portal(db) and rx.status in ("draft", "entered-in-error"):
            return None
        return RefillablePrescription(
            id=rx.id, patient_id=rx.patient_id, intent="order", status=rx.status,
            signed=rx.signed_at is not None, dea_schedule=rx.dea_schedule,
            facility_id=rx.facility_id)

    async def open_request(self, db: Any, prescription_id: UUID) -> bool:
        return any(c == db.tenant_id and r.prescription_id == prescription_id
                   and r.status == "active" for c, r in self.refills.rows.values())

    async def portal_requests(self, db: Any, patient_id: UUID, *, limit: int, offset: int,
                              request_id: UUID | None = None) -> list[RefillRow]:
        rows = [r for c, r in self.refills.rows.values()
                if self._visible(db, c, r.patient_id) and r.patient_id == patient_id
                and (request_id is None or r.id == request_id)]
        rows.sort(key=lambda r: r.id)
        rows.sort(key=lambda r: r.requested_at, reverse=True)
        return [self._full(db, r) for r in rows[offset:offset + limit]]

    async def staff_requests(self, db: Any, *, status: str, facility_ids: Collection[UUID],
                             limit: int, offset: int) -> list[RefillRow]:
        rows = [self._full(db, r) for c, r in self.refills.rows.values()
                if c == db.tenant_id and r.status == status]
        rows = [r for r in rows if r.facility_id is None or r.facility_id in facility_ids]
        rows.sort(key=lambda r: (r.requested_at, r.id))
        return rows[offset:offset + limit]

    async def staff_request(self, db: Any, request_id: UUID) -> RefillRow | None:
        found = self.refills.rows.get(request_id)
        if found is None or found[0] != db.tenant_id:
            return None
        return self._full(db, found[1])

    # ----------------------------------------------------------------------------- writes
    async def create_refill_request(self, db: Any, request: RefillRequestIn) -> fs.Written:
        if request.note is not None and request.note.strip():
            raise fs.InvalidInput("a refill request takes no note", field="note")
        if await self.open_request(db, request.prior_prescription_id):
            raise fs.RefillAlreadyRequested
        rid = self.refills.add(db.tenant_id, request.patient_id, request.prior_prescription_id)
        row = self.refills.row(rid)
        return fs.Written(rid, row.version, row.last_updated)

    async def respond_to_refill_request(self, db: Any, request_id: UUID, *, approve: bool,
                                        reason: str | None, if_version: int) -> fs.Written:
        found = self.refills.rows.get(request_id)
        if found is None or found[0] != db.tenant_id:
            raise fs.ResourceNotFound
        clinic, row = found
        if row.status != "active":
            raise fs.InvalidTransition(row.status)
        if row.version != if_version:
            raise fs.StaleVersion(row.version)
        wording = None if approve else fs.REFILL_DECLINE_REASONS.get(reason or "")
        if not approve and wording is None:
            raise fs.InvalidInput("a declined refill needs one of the listed reasons",
                                  field="reason")
        now = self.world.tick()
        self.refills.rows[request_id] = (clinic, replace(
            row, status="completed" if approve else "cancelled",
            decline_reason=wording, last_updated=now,
            version=row.version + 1))
        if db.user_id is not None:
            self.refills.updated_by[request_id] = db.user_id
        return fs.Written(request_id, row.version + 1, now)


class FakeRefillRepository(FakeRepository):
    """The medications fake, whose drafts remember their ``priorPrescription``."""

    def __init__(self, world: World, refills: Refills) -> None:
        super().__init__(world)
        self.refills = refills

    async def create_prescription(self, db: Any, data: fs.PrescriptionIn) -> fs.Written:
        written = await super().create_prescription(db, data)
        prior = getattr(data, "prior_prescription_id", None)
        if prior is not None:
            self.refills.priors[written.id] = prior
        return written


def fake_chart_view(world: World) -> Any:
    async def view(db: Any, user: CurrentUser, patient_id: UUID) -> ChartAccess:
        if world.patients.get(patient_id) != db.tenant_id:
            return ChartAccess.NOT_FOUND
        if patient_id not in world.restricted:
            return ChartAccess.OPEN
        if (user.id, patient_id) in world.grants:
            return ChartAccess.BREAK_GLASS
        return ChartAccess.BLOCKED
    return view


def fake_summaries(world: World) -> Any:
    """A minimum-necessary summary per patient of the session's clinic (synthetic names)."""
    from app.modules.patients.schemas import HumanName, PatientSummary

    async def find(db: Any, patient_ids: list[UUID]) -> dict[UUID, PatientSummary]:
        return {p: PatientSummary(id=p, name=HumanName(family="Lindgren118", given=["Kaia401"]),
                                  mrn=f"TEST-{p.hex[:6]}", restricted=p in world.restricted,
                                  active=True)
                for p in patient_ids if world.patients.get(p) == db.tenant_id}
    return find


def recording_publish(refills: Refills) -> Any:
    async def publish(db: Any, type: str, subject: str,  # noqa: A002 (core's signature)
                      data: dict[str, Any] | None = None, **scope: Any) -> UUID:
        refills.events.append((type, subject, dict(data or {}), scope))
        return uuid4()
    return publish
