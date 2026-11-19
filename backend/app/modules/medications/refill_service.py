"""Refill requests (#400; inventory #128, #129): the rules behind the portal's request and the
prescriber's answer.

- **Asking** (``request_refill``, the patient's session): only the session patient's own
  prescription (``404`` otherwise, as for one that doesn't exist; D84), active and signed
  (``not-active``), not a controlled substance, PSY or of a schedule that can't be read
  (``not-refillable``; migration 0028, which decides) and with no open request
  (``refill-already-requested``); each refusal is ``409 invalid-state-transition`` naming
  ``/prescriptionId``. A request carries no free text: a non-empty ``note`` is ``422``
  ``/note`` ``not-allowed-value`` (Vimal, for the demo; the helper refuses one too). The
  request and its ``refill-request.received`` event commit together.
- **The staff list** (``list_requests``): the clinic's requests at the user's facilities (a
  prescription written outside a visit has no facility and is listed for all, as ``readable``
  lets it be read), open first, then oldest. A restricted chart the user may not open (D37) is
  listed without its clinical fields (``restricted: true``), never refused; nothing is audited
  as a refusal, since nothing was opened.
- **The answer** (``respond``): MD and APP only (D110), checked before anything is read; then
  the body's rules (``reason`` required to decline, refused with approve, and one of the codes
  of ``fs.REFILL_DECLINE_REASONS``: ``422`` ``/reason`` ``not-allowed-value`` otherwise; the
  patient reads that code's words as ``declineReason``), ``404`` outside the
  clinic or the user's facilities, the restricted-chart check (``403 break-glass-required``)
  and ``409`` with ``currentState`` once answered. Approving writes the request
  ``completed`` and a **draft** prescription copied from the refilled one, outside any visit,
  with ``priorPrescription``; the prescriber then runs the safety check and sign-and-send on
  it, so the fixed alerts (D99) and the outbox (D25) apply as to any prescription; the
  response's ``newPrescriptionId`` is that draft. Declining writes it ``cancelled`` with the
  reason's code and words. One transaction; the caller commits.

Nothing here logs a note, a reason or a drug.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, cast
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access import ChartAccess, require_facility
from app.core.deps import CurrentUser, PortalPatient
from app.core.errors import Conflict, NotFound, field_error
from app.db import fhir_store as fs

from . import portal_schemas as ps
from . import schemas, service
from .refill_repository import (
    STATUS,
    RefillReads,
    RefillRequestIn,
    RefillRow,
    RefillStore,
    draft_in,
)
from .repository import MedicationRepository

PAGE_MAX = 100
RECEIVED = "refill-request.received"
FHIR_STATUS = {state: fhir for fhir, state in STATUS.items()}

#: core.access.chart_access: how the user may open a chart, without refusing or auditing.
ChartView = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[ChartAccess]]
#: The minimum-necessary summary of each patient found (patients.service.summaries, D54).
Summaries = Callable[[AsyncSession, list[UUID]], Awaitable[dict[UUID, Any]]]
#: core.events.publish.
Publish = Callable[..., Awaitable[Any]]


def _state(fhir_status: str) -> schemas.RefillStatus:
    return cast(schemas.RefillStatus, STATUS[fhir_status])


def _refused(code: str) -> Conflict:
    return Conflict(code="invalid-state-transition",
                    errors=[field_error("body", "/prescriptionId", code)])


def _answered(fhir_status: str) -> Conflict:
    return Conflict(code="invalid-state-transition",
                    currentState=STATUS.get(fhir_status, fhir_status))


# ------------------------------------------------------------------------------- read models
def to_portal(row: RefillRow) -> ps.PortalRefillRequest:
    return ps.PortalRefillRequest(
        id=row.id, prescription_id=row.prescription_id,
        display=(row.display or "Medication")[:500], dosage_text=row.dosage_text,
        status=_state(row.status), requested_at=row.requested_at,
        responded_at=row.responded_at, decline_reason=row.decline_reason,
        new_prescription_id=row.new_prescription_id)


def to_staff(row: RefillRow, *, open_chart: bool, patient: Any = None,
             new_prescription_id: UUID | None = None) -> schemas.RefillRequest:
    """The staff view; a chart the user may not open leaves out the clinical fields (D37)."""
    responded_by = (schemas.ClinicianRef(id=row.responder_id,
                                         display_name=(row.responder_name
                                                       or "Unnamed clinician")[:200])
                    if row.responder_id is not None and row.status != "active" else None)
    return schemas.RefillRequest(
        id=row.id, status=_state(row.status), patient_id=row.patient_id,
        patient=patient if open_chart else None, prescription_id=row.prescription_id,
        display=row.display[:500] if open_chart and row.display else None,
        dosage_text=row.dosage_text if open_chart else None,
        requested_at=row.requested_at, note=row.note if open_chart else None,
        responded_at=row.responded_at, responded_by=responded_by,
        decline_reason=row.decline_reason,
        new_prescription_id=new_prescription_id or row.new_prescription_id,
        restricted=not open_chart)


# --------------------------------------------------------------------------- the portal
async def list_mine(db: AsyncSession, reads: RefillReads, patient: PortalPatient, *,
                    limit: int, cursor: str | None) -> ps.PortalRefillRequestList:
    offset = service.decode_cursor(cursor)
    size = min(limit, PAGE_MAX)
    rows = await reads.portal_requests(db, patient.patient_id, limit=size + 1, offset=offset)
    return ps.PortalRefillRequestList(
        items=[to_portal(r) for r in rows[:size]],
        next_cursor=service.encode_cursor(offset + size) if len(rows) > size else None)


async def request_refill(db: AsyncSession, reads: RefillReads, store: RefillStore,
                         publish: Publish, patient: PortalPatient,
                         body: ps.PortalRefillRequestCreate) -> ps.PortalRefillRequest:
    """The session patient asks to refill one of their own prescriptions (no commit)."""
    if body.note is not None and body.note.strip():
        raise service.invalid("/note", "not-allowed-value")
    rx = await reads.prescription(db, body.prescription_id)
    if rx is None or rx.patient_id != patient.patient_id or rx.intent != "order":
        raise NotFound()  # another patient's, a reported medication, or none: the same 404
    if rx.status != "active" or not rx.signed:
        raise _refused("not-active")
    if rx.dea_schedule is not None:
        raise _refused("not-refillable")
    if await reads.open_request(db, rx.id):
        raise _refused("refill-already-requested")
    try:
        written = await store.create_refill_request(db, RefillRequestIn(
            patient_id=patient.patient_id, prior_prescription_id=rx.id))
    except fs.PatientMerged:
        raise Conflict(code="patient-merged") from None
    except fs.RefillAlreadyRequested:  # the unique index, under a concurrent request
        raise _refused("refill-already-requested") from None
    except fs.RefillNotAllowed as refused:  # the database's own rule (migration 0028)
        raise _refused(refused.current_state) from None
    except fs.ResourceNotFound:
        raise NotFound() from None
    await publish(db, RECEIVED, f"refill-request/{written.id}", {
        "refillRequestId": str(written.id), "prescriptionId": str(rx.id),
        "patientId": str(patient.patient_id), "status": "requested"},
        facility_id=rx.facility_id, patient_id=patient.patient_id)
    found = await reads.portal_requests(db, patient.patient_id, limit=1, offset=0,
                                        request_id=written.id)
    if not found:  # pragma: no cover - written in this transaction
        raise NotFound()
    return to_portal(found[0])


# ---------------------------------------------------------------------------------- staff
async def list_requests(db: AsyncSession, reads: RefillReads, view: ChartView,
                        summaries: Summaries, user: CurrentUser, *, status: str, limit: int,
                        cursor: str | None) -> tuple[schemas.RefillRequestList, list[UUID]]:
    """One page, and every patient on it (for the audit row)."""
    offset = service.decode_cursor(cursor)
    size = min(limit, PAGE_MAX)
    rows = await reads.staff_requests(db, status=FHIR_STATUS[status],
                                      facility_ids=user.facility_ids, limit=size + 1,
                                      offset=offset)
    page = rows[:size]
    patients = list(dict.fromkeys(r.patient_id for r in page))
    opened = {p for p in patients if (await view(db, user, p)).allowed}
    found = await summaries(db, sorted(opened)) if opened else {}
    return (schemas.RefillRequestList(
        items=[to_staff(r, open_chart=r.patient_id in opened, patient=found.get(r.patient_id))
               for r in page],
        next_cursor=service.encode_cursor(offset + size) if len(rows) > size else None),
        patients)


async def respond(db: AsyncSession, reads: RefillReads, repo: MedicationRepository,
                  store: RefillStore, check: service.ChartCheck, summaries: Summaries,
                  user: CurrentUser, request_id: UUID, body: schemas.RefillRequestResponse
                  ) -> schemas.RefillRequest:
    """Approves or declines, in the caller's transaction (no commit)."""
    service.require_prescriber(user)  # D110, before anything is read
    approve = body.decision == "approve"
    reason = body.reason.strip() if body.reason is not None else None
    if approve and body.reason is not None:
        raise service.invalid("/reason", "conflicting-fields")
    if not approve and reason is None:
        raise service.invalid("/reason", "required")
    if reason is not None and reason not in fs.REFILL_DECLINE_REASONS:
        raise service.invalid("/reason", "not-allowed-value")
    row = await reads.staff_request(db, request_id)
    if row is None:
        raise NotFound()
    if row.facility_id is not None:
        require_facility(user, row.facility_id)
    await check(db, user, row.patient_id)
    if row.status != "active":
        raise _answered(row.status)
    await service._prescriber(db, repo, user)  # the answer is written as a practitioner's
    draft = await _draft(db, repo, row) if approve else None  # read before any write
    try:
        await store.respond_to_refill_request(db, row.id, approve=approve, reason=reason,
                                              if_version=row.version)
    except fs.InvalidInput as refused:  # pragma: no cover - the reason is checked above
        raise service.invalid("/reason", "not-allowed-value") from refused
    except (fs.InvalidTransition, fs.StaleVersion):
        now = await reads.staff_request(db, row.id)
        raise _answered(now.status if now is not None else "active") from None
    except fs.ResourceNotFound:
        raise NotFound() from None
    new_id = None
    if draft is not None:
        try:
            new_id = (await repo.create_prescription(db, draft)).id
        except (fs.ResourceNotFound, fs.InvalidInput) as error:
            raise service._helper_error(error) from None
    after = await reads.staff_request(db, row.id)
    if after is None:  # pragma: no cover - written in this transaction
        raise NotFound()
    found = await summaries(db, [row.patient_id])
    return to_staff(after, open_chart=True, patient=found.get(row.patient_id),
                    new_prescription_id=new_id)


async def _draft(db: AsyncSession, repo: MedicationRepository, row: RefillRow
                 ) -> fs.PrescriptionIn:
    """The refilled prescription as a new draft. Its pharmacy only while it is still active
    (else the prescriber picks one); its DEA schedule from today's terminology, and its refills
    within that schedule's limit, so the draft is one the database accepts."""
    prior = await repo.prescription(db, row.prescription_id)
    if prior is None:
        raise NotFound()
    pharmacy = (prior.pharmacy_id if prior.pharmacy_id is not None
                and await repo.pharmacy_active(db, prior.pharmacy_id) else None)
    schedule = await repo.dea_schedule(db, prior.drug) or prior.dea_schedule
    allowed = service.MAX_REFILLS.get(schedule or "")
    refills = (min(prior.refills, allowed) if allowed is not None and prior.refills is not None
               else prior.refills)
    return draft_in(prior, pharmacy_id=pharmacy, dea_schedule=schedule, refills=refills)
