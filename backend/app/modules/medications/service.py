"""The medication list and prescriptions (D28, D97, D99): the rules behind the API, the NewRx the
e-prescribing adapter sends, and the pharmacy's answer that /hooks/erx files. Built by Vimal
under D97, reviewed by Thulasi as the medications owner.

- **The list** (``list_medications``, ``record_medication``): what the patient takes, reported at
  rooming (a MedicationRequest with intent ``plan``, ``reportedBoolean``, never signed; D28) or
  prescribed and signed here.
- **Drafts** (``create_prescription``, ``update_prescription``, ``enter_in_error``): written by
  the current user's practitioner, edited with ``If-Match``, locked once signed.
- **The safety check** (``check_safety``): the fixed rules in rules.py on the draft's version,
  stored as its alerts; it doesn't change the draft's version (A58).
- **Overrides** (``override``): a reason, once, while the draft is a draft.
- **Signing** (``sign_and_send``): refused (422) while a field needed to sign is missing, the
  latest check isn't this version's (``safety-check-stale``) or a ``high`` alert has no override
  (``override-required`` at ``/alerts/{i}``); then the NewRx in the outbox, the signature (the
  prescription locked, its Provenance, the transmission ``queued``, on the list) and the events,
  all in the caller's one transaction (D8, D25).
- **For the e-prescribing adapter** (``build_new_rx``, ``record_sent``, ``record_failed``) and
  **the /hooks/erx receiver** (``record_status``), in a clinic session (no user).

Payloads are never logged: they hold names, dates of birth and drugs.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access import require_facility
from app.core.deps import CurrentUser
from app.core.errors import (
    Conflict,
    Forbidden,
    InvalidCursor,
    NotFound,
    PreconditionFailed,
    PreconditionRequired,
    ValidationFailed,
    field_error,
)
from app.db import fhir_store as fs
from app.db.models.systems import NDC, RXNORM

from . import messages, repository, rules, schemas
from .partner import Partner, announce
from .repository import Drug, MedicationRepository, PrescriptionRow

ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Any]
PAGE_MAX = 100  # MedicationList.items maxItems
LIST_STATUSES = ("active", "completed", "stopped")
DRUG_SYSTEMS = (RXNORM, NDC)
#: Who may draft, edit, check, override for, sign and send, or mark a draft entered-in-error in
#: the MVP (D110; for the clinical advisors to confirm, Q21). RN holds the permissions in core's
#: catalogue but is refused here, as scheduling's VISIT_STEP_ROLES limits a permission by role.
PRESCRIBER_ROLES = frozenset({"MD", "APP"})
#: Visits a prescription can't be written in: closed, or never real.
CLOSED_VISITS = frozenset({"finished", "cancelled", "entered-in-error"})
#: DetectedIssue.severity -> the contract's SafetyAlert.severity (db/CLAUDE.md).
SEVERITY = {"low": "info", "moderate": "warning", "high": "high"}
#: DetectedIssue.code (v3 ActCode) -> the contract's SafetyAlert.kind.
KIND = {"ALGY": "allergy", "DUPTHPY": "duplicate-medication", "DRG": "interaction"}
#: 21 CFR 1306: no refills on Schedule II, at most 5 on III to V (the database checks it too).
MAX_REFILLS = {"CII": 0, "CIII": 5, "CIV": 5, "CV": 5}
SIGNED = "prescription.signed"
TRANSMISSION_UPDATED = "prescription.transmission-updated"
#: What the prescriber sees when the pharmacy rejects without words, by NCPDP error code.
REJECTION_MESSAGES = {
    "900": "The pharmacy rejected the prescription.",
    "601": "The pharmacy could not process the prescription.",
    "602": "The pharmacy's system had an error; send it again or call the pharmacy.",
}
FAILED_MESSAGE = "The prescription could not be delivered to the pharmacy."


# ------------------------------------------------------------------------------ helpers
def business_rule(pointer: str, code: str) -> ValidationFailed:
    return ValidationFailed(code="business-rule-violation",
                            errors=[field_error("body", pointer, code)])


def invalid(pointer: str, code: str) -> ValidationFailed:
    return ValidationFailed(errors=[field_error("body", pointer, code)])


def etag(version: int) -> str:
    """A strong ETag from the row version (API_STANDARDS §11)."""
    return f'"{version}"'


def if_match_version(header: str | None) -> int:
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if value.startswith('"') and value.endswith('"') and value[1:-1].isdigit():
        return int(value[1:-1])
    raise PreconditionFailed()  # a weak or malformed tag never matches a strong one


def stale(version: int) -> PreconditionFailed:
    return PreconditionFailed(headers={"ETag": etag(version)})


def encode_cursor(offset: int) -> str:
    """Opaque page cursor. Core's encrypted cursors (T22) replace this when they land."""
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError) as bad:
        raise InvalidCursor() from bad
    kind, _, number = raw.partition(":")
    if kind != "o" or not number.isdigit():
        raise InvalidCursor()
    return int(number)


def drug_in(concept: schemas.CodeableConcept, pointer: str = "/medication") -> fs.Coded:
    """The contract's CodeableConcept as the one coding the MedicationRequest stores: RxNorm (or
    NDC), or text alone."""
    codings = concept.codings or []
    if len(codings) > 1:
        raise invalid(f"{pointer}/codings", "too-long")  # one coding is stored
    if not codings and not (concept.text and concept.text.strip()):
        raise invalid(pointer, "required")
    if codings and codings[0].system not in DRUG_SYSTEMS:
        raise invalid(f"{pointer}/codings/0/system", "not-allowed-value")
    coding = codings[0] if codings else None
    return fs.Coded(system=coding.system if coding else None,
                    code=coding.code if coding else None,
                    display=coding.display if coding else None, text=concept.text)


def drug_out(drug: Drug) -> schemas.CodeableConcept:
    return schemas.CodeableConcept(
        codings=[schemas.Coding(system=drug.system, code=drug.code, display=drug.display)]
        if drug.system and drug.code else None,
        text=drug.text)


def _drug_of(coded: fs.Coded) -> Drug:
    return Drug(system=coded.system, code=coded.code, display=coded.display, text=coded.text)


async def _known(db: AsyncSession, repo: MedicationRepository, drug: fs.Coded) -> None:
    """A prescription's RxNorm code must be in the loaded RxNorm Current Prescribable Content
    (the codes `GET /codes?system=rxnorm` offers); NDC and text alone are not checked here."""
    if drug.system == RXNORM and drug.code and not await repo.known_rxnorm(db, drug.code):
        raise invalid("/medication/codings/0/code", "invalid-reference")


def _check_refills(dea_schedule: str | None, refills: int | None) -> None:
    allowed = MAX_REFILLS.get(dea_schedule or "")
    if allowed is not None and (refills or 0) > allowed:
        raise invalid("/refills", "out-of-range")


def _quantity(q: schemas.Quantity | None) -> fs.DispenseQuantity | None:
    return fs.DispenseQuantity(q.value, q.unit) if q is not None else None


def _helper_error(error: Exception, *, locked_code: str = "invalid-state-transition"
                  ) -> Exception:
    """A write helper's exception as core's error."""
    if isinstance(error, fs.SignRefused):
        return ValidationFailed(code="business-rule-violation",
                                errors=[field_error("body", p, c) for p, c in error.errors])
    if isinstance(error, fs.StaleVersion):
        return stale(error.current_version)
    if isinstance(error, fs.InvalidTransition):
        if locked_code == "record-locked":
            return Conflict(code="record-locked")
        return Conflict(code=locked_code, currentState=error.current_state)
    if isinstance(error, fs.ResourceNotFound):
        return NotFound()
    if isinstance(error, fs.InvalidInput):
        if error.field == "reason":
            return invalid("/reason", "too-short")
        return ValidationFailed(error.reason)
    return error


# ------------------------------------------------------------------------- read models
def to_medication(row: repository.MedicationRow) -> schemas.Medication:
    prescribed = row.intent == "order"
    return schemas.Medication(
        id=row.id, patient_id=row.patient_id, medication=drug_out(row.drug),
        dosage_text=row.dosage_text, status=row.status,
        source="prescription" if prescribed else "reported",
        prescription_id=row.id if prescribed else None, note=row.note,
        recorded_at=row.recorded_at, recorded_by=row.recorded_by)


def to_alert(a: repository.AlertRow) -> schemas.SafetyAlert:
    severity = SEVERITY.get(a.severity or "", "info")
    return schemas.SafetyAlert(
        id=a.id, kind=KIND.get(a.code or "", a.code or "unknown"), severity=severity,
        message=a.message or "", allergy_id=a.allergy_id, medication_id=a.medication_id,
        override_required=severity == "high",
        override=schemas.Override(reason=a.override_reason, overridden_by=a.overridden_by,
                                  overridden_at=a.overridden_at)
        if a.override_reason is not None and a.overridden_at is not None else None)


def to_prescription(row: PrescriptionRow) -> schemas.Prescription:
    t = row.transmission
    return schemas.Prescription(
        id=row.id, patient_id=row.patient_id, encounter_id=row.encounter_id,
        status=row.status, medication=drug_out(row.drug), dosage_text=row.dosage_text,
        quantity=schemas.QuantityOut(value=float(row.quantity_value), unit=row.quantity_unit)
        if row.quantity_value is not None and row.quantity_unit is not None else None,
        days_supply=int(row.days_supply) if row.days_supply is not None else None,
        refills=row.refills, substitution_allowed=row.substitution_allowed,
        pharmacy_id=row.pharmacy_id, note_to_pharmacy=row.note_to_pharmacy,
        prescriber_id=row.signed_by, signed_at=row.signed_at,
        transmission=schemas.Transmission(
            status=t.status, updated_at=t.updated_at,
            message=t.message if t.status in ("rejected", "error") else None)
        if t is not None else schemas.Transmission(status="not-sent"),
        safety_checked_at=row.safety_checked_at,
        alerts=[to_alert(a) for a in row.alerts],
        created_at=row.created_at, updated_at=row.updated_at)


def sign_refusals(row: PrescriptionRow) -> list[tuple[str, str]]:
    """Why the draft can't be signed, as ``sign_prescription`` refuses it (pure): a field needed
    to sign, then a stale check, else each ``high`` alert without an override, by its index."""
    errors = [(pointer, "required") for pointer, missing in (
        ("/dosageText", not (row.dosage_text and row.dosage_text.strip())),
        ("/quantity", row.quantity_value is None),
        ("/pharmacyId", row.pharmacy_id is None)) if missing]
    if row.safety_checked_at is None:
        errors.append(("/alerts", "safety-check-stale"))
    else:
        errors += [(f"/alerts/{i}", "override-required") for i, a in enumerate(row.alerts)
                   if a.severity == "high" and a.override_reason is None]
    return errors


# ------------------------------------------------------------------------ the list
async def list_medications(db: AsyncSession, repo: MedicationRepository, check: ChartCheck,
                           user: CurrentUser, patient_id: UUID, *, status: str | None,
                           limit: int, cursor: str | None) -> schemas.MedicationList:
    """Active first, then newest. 404 for a patient the clinic can't see; 403 for a restricted
    chart without a grant or care-team membership (D37)."""
    offset = decode_cursor(cursor)
    await check(db, user, patient_id)
    size = min(limit, PAGE_MAX)
    rows = await repo.medications(db, patient_id, [status] if status else LIST_STATUSES,
                                  limit=size + 1, offset=offset)
    return schemas.MedicationList(items=[to_medication(r) for r in rows[:size]],
                                  next_cursor=encode_cursor(offset + size)
                                  if len(rows) > size else None)


async def record_medication(db: AsyncSession, repo: MedicationRepository, check: ChartCheck,
                            user: CurrentUser, patient_id: UUID,
                            body: schemas.MedicationCreate) -> schemas.Medication:
    """A medication the patient already takes (D28), in the caller's transaction (no commit)."""
    await check(db, user, patient_id)
    patient = await repo.patient(db, patient_id)
    if patient is None:
        raise NotFound()
    if patient.merged:
        raise Conflict(code="patient-merged")
    note = body.note if body.note and body.note.strip() else None
    try:
        medication_id = await repo.record_medication(db, fs.MedicationIn(
            patient_id=patient_id, medication=drug_in(body.medication),
            dosage_text=body.dosage_text, status=body.status, note=note))
    except (fs.ResourceNotFound, fs.InvalidInput) as error:
        raise _helper_error(error) from None
    row = await repo.medication(db, medication_id)
    if row is None:  # pragma: no cover - written in this transaction
        raise NotFound()
    return to_medication(row)


# ------------------------------------------------------------------------ prescriptions
async def readable(db: AsyncSession, repo: MedicationRepository, check: ChartCheck,
                   user: CurrentUser, prescription_id: UUID) -> PrescriptionRow:
    """404 for another clinic's prescription or one written in a visit at a facility not the
    user's; 403 for a restricted chart without a grant or care-team membership (D37)."""
    row = await repo.prescription(db, prescription_id)
    if row is None:
        raise NotFound()
    if row.encounter_id is not None:
        require_facility(user, row.facility_id)
    await check(db, user, row.patient_id)
    return row


def require_prescriber(user: CurrentUser) -> None:
    """D110: drafting, editing, checking, overriding, signing and sending, and marking a draft
    entered-in-error are for PRESCRIBER_ROLES only. A user who holds the permission without one
    of those roles (RN) gets 403 permission-denied. Checked first, before any read or write."""
    if not user.roles & PRESCRIBER_ROLES:
        raise Forbidden("Only MD and APP may prescribe in the MVP", code="permission-denied")


async def prescribable(db: AsyncSession, repo: MedicationRepository, check: ChartCheck,
                       user: CurrentUser, prescription_id: UUID) -> PrescriptionRow:
    """The role rule (D110), then the prescription as ``readable`` finds it."""
    require_prescriber(user)
    return await readable(db, repo, check, user, prescription_id)


async def _prescriber(db: AsyncSession, repo: MedicationRepository, user: CurrentUser) -> None:
    """The requester and the signer are practitioners: an MD or APP account not linked to one
    can't be written as either (a set-up gap, not a role question; D110 is require_prescriber)."""
    if await repo.practitioner_of_user(db, user.id) is None:
        raise Forbidden("Your account is not linked to a practitioner")


async def create_prescription(db: AsyncSession, repo: MedicationRepository, check: ChartCheck,
                              user: CurrentUser, body: schemas.PrescriptionCreate
                              ) -> tuple[PrescriptionRow, UUID]:
    """A draft, in the caller's transaction (no commit). Returns it and its patient."""
    require_prescriber(user)
    await check(db, user, body.patient_id)
    patient = await repo.patient(db, body.patient_id)
    if patient is None:
        raise NotFound()
    if body.encounter_id is not None:
        visit = await repo.encounter(db, body.encounter_id)
        if visit is None:
            raise NotFound()
        require_facility(user, visit.facility_id)
        if visit.patient_id != body.patient_id:
            raise business_rule("/encounterId", "invalid-reference")
        if visit.status in CLOSED_VISITS:
            raise business_rule("/encounterId", "not-allowed-value")
    if patient.merged:
        raise Conflict(code="patient-merged")
    medication = drug_in(body.medication)
    await _known(db, repo, medication)
    if body.pharmacy_id is not None:
        active = await repo.pharmacy_active(db, body.pharmacy_id)
        if active is None:
            raise NotFound()
        if not active:
            raise business_rule("/pharmacyId", "not-allowed-value")
    schedule = await repo.dea_schedule(db, _drug_of(medication))
    _check_refills(schedule, body.refills)
    await _prescriber(db, repo, user)
    try:
        written = await repo.create_prescription(db, fs.PrescriptionIn(
            patient_id=body.patient_id, medication=medication, encounter_id=body.encounter_id,
            dosage_text=body.dosage_text, quantity=_quantity(body.quantity),
            days_supply=body.days_supply, refills=body.refills,
            substitution_allowed=body.substitution_allowed, pharmacy_id=body.pharmacy_id,
            note_to_pharmacy=body.note_to_pharmacy, dea_schedule=schedule))
    except (fs.ResourceNotFound, fs.InvalidInput) as error:
        raise _helper_error(error) from None
    row = await repo.prescription(db, written.id)
    if row is None:  # pragma: no cover - written in this transaction
        raise NotFound()
    return row, body.patient_id


def _given(body: schemas.PrescriptionPatch, name: str) -> bool:
    return name in body.model_fields_set


async def update_prescription(db: AsyncSession, repo: MedicationRepository,
                              current: PrescriptionRow, body: schemas.PrescriptionPatch,
                              if_match: str | None) -> PrescriptionRow:
    """Only what is sent changes; ``null`` clears it (the drug can't be cleared). A signed
    prescription is ``409 record-locked``; a stale ``If-Match`` is ``412``. Any change is a new
    version, so the safety check must run again (no commit)."""
    version = if_match_version(if_match)
    if current.status != "draft":
        raise Conflict(code="record-locked")
    if version != current.version:
        raise stale(current.version)
    if _given(body, "medication") and body.medication is None:
        raise invalid("/medication", "required")
    unset = fs.UNSET
    medication = drug_in(body.medication) if body.medication is not None else None
    if medication is not None:
        await _known(db, repo, medication)
    schedule = (await repo.dea_schedule(db, _drug_of(medication)) if medication is not None
                else current.dea_schedule)
    refills = body.refills if _given(body, "refills") else current.refills
    _check_refills(schedule, refills)
    if body.pharmacy_id is not None:
        active = await repo.pharmacy_active(db, body.pharmacy_id)
        if active is None:
            raise NotFound()
        if not active:
            raise business_rule("/pharmacyId", "not-allowed-value")
    changes = fs.PrescriptionChanges(
        medication=medication if medication is not None else unset,
        dosage_text=body.dosage_text if _given(body, "dosage_text") else unset,
        quantity=_quantity(body.quantity) if _given(body, "quantity") else unset,
        days_supply=body.days_supply if _given(body, "days_supply") else unset,
        refills=body.refills if _given(body, "refills") else unset,
        substitution_allowed=(body.substitution_allowed if _given(body, "substitution_allowed")
                              else unset),
        pharmacy_id=body.pharmacy_id if _given(body, "pharmacy_id") else unset,
        note_to_pharmacy=body.note_to_pharmacy if _given(body, "note_to_pharmacy") else unset,
        dea_schedule=schedule if medication is not None else unset)
    try:
        written = await repo.update_prescription(db, current.id, changes, if_version=version)
    except (fs.StaleVersion, fs.InvalidTransition, fs.ResourceNotFound,
            fs.InvalidInput) as error:
        raise _helper_error(error, locked_code="record-locked") from None
    row = await repo.prescription(db, written.id)
    if row is None:  # pragma: no cover
        raise NotFound()
    return row


async def enter_in_error(db: AsyncSession, repo: MedicationRepository, current: PrescriptionRow,
                         reason: str) -> PrescriptionRow:
    """A draft written by mistake: entered-in-error with the reason and its Provenance, its
    alerts cancelled (no commit). Anything else is ``409`` with ``currentState``."""
    if current.status != "draft":
        raise Conflict(code="invalid-state-transition", currentState=current.status)
    if not reason.strip():
        raise invalid("/reason", "too-short")
    try:
        await repo.prescription_entered_in_error(db, current.id, reason.strip(),
                                                 if_version=None)
    except (fs.InvalidTransition, fs.ResourceNotFound, fs.InvalidInput) as error:
        raise _helper_error(error) from None
    row = await repo.prescription(db, current.id)
    if row is None:  # pragma: no cover
        raise NotFound()
    return row


async def check_safety(db: AsyncSession, repo: MedicationRepository, current: PrescriptionRow
                       ) -> tuple[schemas.SafetyCheckResult, PrescriptionRow]:
    """The fixed rules on this version of the draft, stored as its alerts (the earlier check's
    are cancelled), without a new version (A58; no commit)."""
    if current.status != "draft":
        raise Conflict(code="invalid-state-transition", currentState=current.status)
    row = current
    for attempt in range(2):  # a save between the read and the lock: read it again, once
        facts = await repo.safety_facts(db, row)
        alerts = rules.check(facts.drug, facts.allergies, facts.medications)
        try:
            written = await repo.record_safety_check(db, row.id, tuple(
                fs.AlertIn(rule_code=a.rule_code, kind=a.kind, severity=a.severity,
                           message=a.message, allergy_id=a.allergy_id,
                           medication_id=a.medication_id) for a in alerts),
                if_version=row.version)
            break
        except fs.StaleVersion:
            fresh = await repo.prescription(db, row.id)
            if fresh is None or attempt:
                raise NotFound() if fresh is None else stale(fresh.version) from None
            if fresh.status != "draft":
                raise Conflict(code="invalid-state-transition",
                               currentState=fresh.status) from None
            row = fresh
        except (fs.InvalidTransition, fs.ResourceNotFound, fs.InvalidInput) as error:
            raise _helper_error(error) from None
    checked = await repo.prescription(db, row.id)
    if checked is None:  # pragma: no cover
        raise NotFound()
    return schemas.SafetyCheckResult(prescription_id=row.id, checked_at=written.checked_at,
                                     alerts=[to_alert(a) for a in checked.alerts]), checked


async def override(db: AsyncSession, repo: MedicationRepository, check: ChartCheck,
                   user: CurrentUser, alert_id: UUID, reason: str
                   ) -> tuple[schemas.SafetyAlert, UUID]:
    """The prescriber goes ahead despite an alert, with a reason (no commit). ``409`` when the
    alert is already overridden or its prescription is no longer a draft. Returns the alert and
    the patient."""
    require_prescriber(user)
    prescription_id = await repo.alert_prescription(db, alert_id)
    if prescription_id is None:
        raise NotFound()
    row = await readable(db, repo, check, user, prescription_id)
    if row.status != "draft":
        raise Conflict(code="invalid-state-transition", currentState=row.status)
    alert = next((a for a in row.alerts if a.id == alert_id), None)
    if alert is None:  # an earlier check's alert, cancelled
        raise Conflict(code="invalid-state-transition", currentState="cancelled")
    if alert.override_reason is not None:
        raise Conflict(code="invalid-state-transition", currentState="overridden")
    if len(reason.strip()) < 3:
        raise invalid("/reason", "too-short")
    await _prescriber(db, repo, user)
    try:
        await repo.override_alert(db, alert_id, reason.strip())
    except (fs.InvalidTransition, fs.ResourceNotFound, fs.InvalidInput) as error:
        raise _helper_error(error) from None
    after = await repo.prescription(db, prescription_id)
    found = next((a for a in after.alerts if a.id == alert_id), None) if after else None
    if found is None:  # pragma: no cover
        raise NotFound()
    return to_alert(found), row.patient_id


async def sign_and_send(db: AsyncSession, repo: MedicationRepository, partner: Partner,
                        user: CurrentUser, current: PrescriptionRow, if_match: str | None
                        ) -> PrescriptionRow:
    """Signs exactly the version read and queues the NewRx, in the caller's one transaction (no
    commit): the outbox message, then the signature (locked, Provenance, transmission
    ``queued``, on the list), then ``prescription.signed`` and
    ``prescription.transmission-updated``."""
    version = if_match_version(if_match)
    if current.status != "draft":
        raise Conflict(code="invalid-state-transition", currentState=current.status)
    if version != current.version:
        raise stale(current.version)
    refusals = sign_refusals(current)
    if refusals:
        raise ValidationFailed(code="business-rule-violation",
                               errors=[field_error("body", p, c) for p, c in refusals])
    await _prescriber(db, repo, user)
    message_id = await partner.send_new_rx(db, current.id)
    try:
        await repo.sign_prescription(db, current.id, if_version=version,
                                     integration_message_id=message_id)
    except (fs.SignRefused, fs.StaleVersion, fs.InvalidTransition, fs.ResourceNotFound,
            fs.InvalidInput) as error:
        raise _helper_error(error) from None
    row = await repo.prescription(db, current.id)
    if row is None:  # pragma: no cover
        raise NotFound()
    scope = {"patient_id": row.patient_id, "facility_id": row.facility_id}
    await partner.announce(db, SIGNED, row.id, {"patientId": str(row.patient_id)}, **scope)
    await partner.announce(db, TRANSMISSION_UPDATED, row.id,
                           {"transmissionStatus": "queued"}, **scope)
    return row


# ------------------------------------------------------- the NewRx, for the erx adapter
class MessageNotBuildable(Exception):
    """No NewRx can be built for this prescription. ``code`` is short and holds no patient
    data, for the adapter's ``DeliveryError(code, permanent=True)``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _present(**members: Any) -> dict[str, Any]:
    """The members that have a value: a message leaves an absent one out, never sends null."""
    return {k: v for k, v in members.items() if v is not None}


def _name(family: str | None, given: tuple[str, ...], code: str) -> messages.PersonName:
    if not family:
        raise MessageNotBuildable(code)
    return messages.PersonName(**_present(
        family=family[:100], given=[g[:100] for g in given if g][:5] or None))


def _utc(at: datetime) -> str:
    return at.astimezone(UTC).replace(microsecond=0, tzinfo=None).isoformat() + "Z"


def _amount(value: Decimal) -> str:
    """A decimal string without an exponent or trailing zeros ("30", "44.5")."""
    text = f"{value:f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def new_rx_from(data: repository.NewRxData, now: datetime) -> messages.NewRx:
    """The NewRx from what the prescription names (pure; see build_new_rx)."""
    if data.intent != "order" or data.status != "active" or data.signed_at is None:
        raise MessageNotBuildable("prescription-not-signed")
    drug = data.drug
    description = drug.display or drug.text
    if not description:
        raise MessageNotBuildable("drug-missing")
    if len(description) > 500:
        raise MessageNotBuildable("drug-description-too-long")
    if not (data.sig and data.sig.strip()):
        raise MessageNotBuildable("sig-missing")
    if data.quantity_value is None or not data.quantity_unit:
        raise MessageNotBuildable("quantity-missing")
    if not data.pharmacy_ncpdp_id:
        raise MessageNotBuildable("pharmacy-missing")
    if not data.prescriber_npi:
        raise MessageNotBuildable("prescriber-npi-missing")
    if data.patient_birth_date is None:
        raise MessageNotBuildable("birth-date-missing")
    rxnorm = drug.code if drug.system == RXNORM and drug.code and drug.code.isdigit() else None
    note = data.note_to_pharmacy if data.note_to_pharmacy and data.note_to_pharmacy.strip() \
        else None
    try:
        return messages.NewRx(
            message_type=messages.NEW_RX, schema_version=messages.SCHEMA_VERSION,
            correlation_id=str(data.prescription_id), created_at=_utc(now),
            signed_at=_utc(data.signed_at),
            prescriber=messages.Prescriber(
                npi=data.prescriber_npi,
                name=_name(data.prescriber_family, data.prescriber_given,
                           "prescriber-name-missing")),
            patient=messages.Patient(
                name=_name(data.patient_family, data.patient_given, "name-missing"),
                birth_date=data.patient_birth_date.isoformat()),
            pharmacy=messages.Pharmacy(**_present(ncpdp_id=data.pharmacy_ncpdp_id,
                                                  npi=data.pharmacy_npi)),
            medication=messages.Medication(**_present(
                rxnorm_code=rxnorm, description=description,
                quantity=messages.Quantity(value=_amount(data.quantity_value),
                                           unit=data.quantity_unit),
                days_supply=int(data.days_supply) if data.days_supply is not None else None,
                refills=data.refills or 0,
                substitution_allowed=(data.substitution_allowed
                                      if data.substitution_allowed is not None else True),
                sig=data.sig, dea_schedule=data.dea_schedule, note_to_pharmacist=note)))
    except ValidationError:
        # A stored value the message can't carry; which one is not said (it may be PHI).
        raise MessageNotBuildable("invalid-field") from None


async def build_new_rx(db: AsyncSession, prescription_id: UUID, *, now: datetime
                       ) -> messages.NewRx:
    """The NewRx for a signed prescription, read in its clinic (the worker's clinic session).
    Send ``.as_json()``; never log it."""
    data = await repository.new_rx_data(db, prescription_id)
    if data is None:
        raise MessageNotBuildable("prescription-not-found")
    return new_rx_from(data, now)


# --------------------------------------------------- the transmission, for the worker
@dataclass(frozen=True)
class Filed:
    prescription_id: UUID
    status: str  # the transmission's status after this
    duplicate: bool  # True: nothing changed (the same status again, or already final)


async def _move(db: AsyncSession, prescription_id: UUID, status: str, *,
                message: str | None = None, vendor_message_id: str | None = None) -> Filed:
    """Moves the NewRx's transmission and publishes ``prescription.transmission-updated`` when
    it changed. 404 for a prescription with no transmission (a draft, or another clinic's)."""
    current = await repository.transmission_status(db, prescription_id)
    if current is None:
        raise NotFound()
    if current == status:
        return Filed(prescription_id, current, duplicate=True)
    try:
        moved = await repository.set_transmission_status(
            db, prescription_id, status, message=message, vendor_message_id=vendor_message_id)
    except fs.InvalidTransition as final:  # accepted or rejected already: a late reply
        return Filed(prescription_id, final.current_state, duplicate=True)
    except fs.ResourceNotFound:
        raise NotFound() from None
    patient_id, facility_id = await repository.event_scope(db, prescription_id)
    await announce(db, TRANSMISSION_UPDATED, prescription_id,
                   {"transmissionStatus": str(moved.status)}, patient_id=patient_id,
                   facility_id=facility_id)
    return Filed(prescription_id, str(moved.status), duplicate=False)


async def record_sent(db: AsyncSession, prescription_id: UUID) -> Filed:
    """For the adapter once the NewRx is delivered: ``sent`` (no commit)."""
    return await _move(db, prescription_id, "sent")


async def record_failed(db: AsyncSession, prescription_id: UUID) -> Filed:
    """For the worker when the NewRx is dead-lettered: ``error``, with a fixed message (the
    adapter's error code may not be shown; no commit). An operator's replay queues it again."""
    return await _move(db, prescription_id, "error", message=FAILED_MESSAGE)


def _pointer(location: tuple[int | str, ...]) -> str:
    return "/" + "/".join(str(p) for p in location) if location else ""


def parse_status(payload: Mapping[str, Any]) -> messages.RxStatus:
    """The reply checked against its shape; 422 naming only where it's wrong, never a value."""
    try:
        return messages.RxStatus.model_validate(payload)
    except ValidationError as wrong:
        found = [field_error("body", _pointer(e["loc"]), "invalid-format")
                 for e in wrong.errors(include_url=False, include_input=False,
                                       include_context=False)][:20]
        raise ValidationFailed(errors=found) from None


async def record_status(db: AsyncSession, payload: Mapping[str, Any]) -> Filed:
    """Files the pharmacy's RxStatus in the caller's transaction (no commit); the session must
    be the prescription's clinic. 422 for a reply that breaks its shape, 404 for an unknown
    ``correlationId`` (or another clinic's, or a draft). Filed once: the same status again, or
    any reply after ``accepted`` or ``rejected``, changes nothing (``duplicate``)."""
    reply = parse_status(payload)
    message = None
    if reply.rejection is not None:
        code = reply.rejection.code
        message = reply.rejection.message or REJECTION_MESSAGES.get(
            code, f"The pharmacy rejected the prescription (NCPDP error {code}).")
    return await _move(db, UUID(reply.correlation_id), reply.status, message=message,
                       vendor_message_id=reply.response_id)
