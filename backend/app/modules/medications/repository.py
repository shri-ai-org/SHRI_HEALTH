"""Medication list and prescription rows, under the caller's session (forced row-level security
keeps each clinic to its own rows). Built by Vimal under D97, reviewed by Thulasi.

- **Writes** go through Anand's helpers in ``app.db.fhir_store`` (``record_medication``,
  ``create_prescription``, ``update_prescription``, ``prescription_entered_in_error``,
  ``record_safety_check``, ``override_alert``, ``sign_prescription``,
  ``set_transmission_status``), which never commit and raise their own exceptions; the service
  turns those into core's errors.
- **Reads** are plain SQL, mapped to the contract as ``backend/app/db/CLAUDE.md`` says
  ("Prescriptions and their alerts"): ``safetyCheckedAt`` only while the check's version is the
  current one; ``alerts`` are the live DetectedIssues identified at the latest check, in
  ``prescription_alert_ids()`` order (by ID), so ``/alerts/{i}`` counts as signing does;
  ``transmission`` is the latest outbound NewRx; on the list, ``source`` is ``reported`` for intent
  ``plan`` and ``prescription`` for a signed order.
- **Terminology** (``admin.concept``, ``admin.concept_property``; ``app.db.terminology``): a
  drug's ingredients are its RxNorm ``ingredient`` properties. A code with none (an ingredient
  itself, or a code the loaded release doesn't have) stands for itself, so the same code always
  matches the same code.
- **Practice data** owned by others (the patient's name, the prescriber's NPI, the pharmacy
  directory) is read here with plain SQL, as eligibility reads its practice data, until their
  read services land.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import fhir_store as fs
from app.db.models.systems import NPI, RXNORM

from . import rules


# ---------------------------------------------------------------------------------- rows
@dataclass(frozen=True)
class Drug:
    """A MedicationRequest's ``medicationCodeableConcept``: one coding and text."""
    system: str | None
    code: str | None
    display: str | None
    text: str | None


@dataclass(frozen=True)
class PatientRef:
    id: UUID
    merged: bool  # merged into another chart (a replaced-by link, D103)


@dataclass(frozen=True)
class EncounterRef:
    id: UUID
    patient_id: UUID
    status: str
    facility_id: UUID | None


@dataclass(frozen=True)
class MedicationRow:
    id: UUID
    patient_id: UUID
    intent: str  # plan (reported) | order (a signed prescription)
    status: str
    drug: Drug
    dosage_text: str | None
    note: str | None
    recorded_at: datetime
    recorded_by: UUID | None


@dataclass(frozen=True)
class AlertRow:
    id: UUID
    code: str | None  # v3 ActCode: ALGY, DUPTHPY, DRG
    severity: str | None  # low | moderate | high
    message: str | None
    allergy_id: UUID | None
    medication_id: UUID | None  # the other medication of a duplicate alert
    override_reason: str | None
    overridden_by: UUID | None  # the user linked to the override's practitioner
    overridden_at: datetime | None


@dataclass(frozen=True)
class TransmissionRow:
    status: str  # queued | sent | accepted | rejected | error
    updated_at: datetime
    message: str | None


@dataclass(frozen=True)
class PrescriptionRow:
    id: UUID
    patient_id: UUID
    encounter_id: UUID | None
    facility_id: UUID | None  # the encounter's
    status: str
    drug: Drug
    dosage_text: str | None
    quantity_value: Decimal | None
    quantity_unit: str | None
    days_supply: Decimal | None
    refills: int | None
    substitution_allowed: bool | None
    pharmacy_id: UUID | None
    note_to_pharmacy: str | None
    dea_schedule: str | None
    signed_by: UUID | None  # the signing user
    signed_at: datetime | None
    version: int
    safety_checked_at: datetime | None  # only while it is this version's check
    created_at: datetime
    updated_at: datetime
    alerts: tuple[AlertRow, ...]
    transmission: TransmissionRow | None


@dataclass(frozen=True)
class SafetyFacts:
    """What the fixed rules (rules.py) read: the draft's drug, the patient's RxNorm-coded
    allergies and the other entries of the medication list, each with its ingredients."""
    drug: rules.Drug
    allergies: tuple[rules.Allergy, ...]
    medications: tuple[rules.ListEntry, ...]


@dataclass(frozen=True)
class NewRxData:
    """What the NewRx needs, in one read (service.build_new_rx)."""
    prescription_id: UUID
    status: str
    intent: str
    signed_at: datetime | None
    drug: Drug
    sig: str | None
    quantity_value: Decimal | None
    quantity_unit: str | None
    days_supply: Decimal | None
    refills: int | None
    substitution_allowed: bool | None
    dea_schedule: str | None
    note_to_pharmacy: str | None
    patient_family: str | None
    patient_given: tuple[str, ...]
    patient_birth_date: date | None
    prescriber_npi: str | None
    prescriber_family: str | None
    prescriber_given: tuple[str, ...]
    pharmacy_ncpdp_id: str | None
    pharmacy_npi: str | None


class MedicationRepository(Protocol):
    # reads
    async def patient(self, db: AsyncSession, patient_id: UUID) -> PatientRef | None: ...
    async def encounter(self, db: AsyncSession, encounter_id: UUID) -> EncounterRef | None: ...
    async def pharmacy_active(self, db: AsyncSession, pharmacy_id: UUID) -> bool | None: ...
    async def practitioner_of_user(self, db: AsyncSession, user_id: UUID) -> UUID | None: ...
    async def dea_schedule(self, db: AsyncSession, drug: Drug) -> str | None: ...
    async def known_rxnorm(self, db: AsyncSession, code: str) -> bool: ...
    async def medications(self, db: AsyncSession, patient_id: UUID, statuses: Sequence[str], *,
                          limit: int, offset: int) -> list[MedicationRow]: ...
    async def medication(self, db: AsyncSession, medication_id: UUID) -> MedicationRow | None: ...
    async def prescription(self, db: AsyncSession, prescription_id: UUID
                           ) -> PrescriptionRow | None: ...
    async def alert_prescription(self, db: AsyncSession, alert_id: UUID) -> UUID | None: ...
    async def safety_facts(self, db: AsyncSession, row: PrescriptionRow) -> SafetyFacts: ...

    # writes, through Anand's helpers (no commit)
    async def record_medication(self, db: AsyncSession, data: fs.MedicationIn) -> UUID: ...
    async def create_prescription(self, db: AsyncSession, data: fs.PrescriptionIn
                                  ) -> fs.Written: ...
    async def update_prescription(self, db: AsyncSession, prescription_id: UUID,
                                  changes: fs.PrescriptionChanges, *, if_version: int
                                  ) -> fs.Written: ...
    async def prescription_entered_in_error(self, db: AsyncSession, prescription_id: UUID,
                                            reason: str, *, if_version: int | None
                                            ) -> fs.Written: ...
    async def record_safety_check(self, db: AsyncSession, prescription_id: UUID,
                                  alerts: tuple[fs.AlertIn, ...], *, if_version: int
                                  ) -> fs.SafetyCheckWritten: ...
    async def override_alert(self, db: AsyncSession, alert_id: UUID, reason: str
                             ) -> fs.Written: ...
    async def sign_prescription(self, db: AsyncSession, prescription_id: UUID, *,
                                if_version: int, integration_message_id: UUID | None
                                ) -> fs.Written: ...


# ------------------------------------------------------------------------------------ SQL
_PATIENT = text("""
SELECT p.id, EXISTS (SELECT 1 FROM clinical.patient_link l
                     WHERE l.patient_id = p.id AND l.type = 'replaced-by') AS merged
FROM clinical.patient p WHERE p.id = :id
""")
_ENCOUNTER = text("""
SELECT id, subject_patient_id, status, ext_facility_id FROM clinical.encounter WHERE id = :id
""")
_PHARMACY = text("SELECT is_active FROM admin.pharmacy WHERE id = :id")
_PRACTITIONER = text("SELECT practitioner_id FROM admin.app_user WHERE id = :id")
_DEA = text("""
SELECT p.value FROM admin.concept c
JOIN admin.code_system s ON s.id = c.code_system_id
JOIN admin.concept_property p ON p.concept_id = c.id AND p.property = 'dea_schedule'
WHERE s.uri = :rxnorm AND c.code = :code
ORDER BY p.value LIMIT 1
""")
_KNOWN = text("""
SELECT EXISTS (SELECT 1 FROM admin.concept c JOIN admin.code_system s ON s.id = c.code_system_id
               WHERE s.uri = :rxnorm AND c.code = :code AND c.is_active)
""")
_LIST_COLUMNS = """
SELECT m.id, m.subject_patient_id, m.intent, m.status,
       m.medication_codeable_concept_system AS system, m.medication_codeable_concept_code AS code,
       m.medication_codeable_concept_display AS display,
       m.medication_codeable_concept_text AS text,
       coalesce(m.ext_signed_at, m.authored_on, m.created_at) AS recorded_at,
       CASE WHEN m.intent = 'order' THEN m.ext_signed_by_user_id
            ELSE m.created_by_user_id END AS recorded_by,
       (SELECT d.text FROM clinical.dosage d WHERE d.medication_request_id = m.id
         ORDER BY d.sequence NULLS LAST, d.id LIMIT 1) AS dosage_text,
       (SELECT n.text FROM clinical.annotation n WHERE n.medication_request_id = m.id
         ORDER BY n.time DESC NULLS LAST, n.id LIMIT 1) AS note
FROM clinical.medication_request m
"""
# On the list (D28): what the patient reported (intent plan) and what was prescribed and signed
# here (intent order); drafts, unsigned orders and entered-in-error entries never.
_ON_THE_LIST = """((m.intent = 'plan' AND m.reported_boolean)
       OR (m.intent = 'order' AND m.ext_signed_at IS NOT NULL))"""
_LIST = text(_LIST_COLUMNS + """
WHERE m.subject_patient_id = :patient AND m.status = ANY(:statuses) AND """ + _ON_THE_LIST + """
ORDER BY (m.status = 'active') DESC, coalesce(m.ext_signed_at, m.authored_on, m.created_at) DESC,
         m.id
LIMIT :limit OFFSET :offset
""")
_ONE_ENTRY = text(_LIST_COLUMNS + "WHERE m.id = :id AND " + _ON_THE_LIST)
_PRESCRIPTION = text("""
SELECT m.id, m.subject_patient_id, m.encounter_id, e.ext_facility_id AS facility_id, m.status,
       m.medication_codeable_concept_system AS system, m.medication_codeable_concept_code AS code,
       m.medication_codeable_concept_display AS display,
       m.medication_codeable_concept_text AS text,
       (SELECT d.text FROM clinical.dosage d WHERE d.medication_request_id = m.id
         ORDER BY d.sequence NULLS LAST, d.id LIMIT 1) AS dosage_text,
       m.dispense_request_quantity_value AS quantity_value,
       m.dispense_request_quantity_unit AS quantity_unit,
       m.dispense_request_expected_supply_duration_value AS days_supply,
       m.dispense_request_number_of_repeats_allowed AS refills,
       m.substitution_allowed_boolean AS substitution_allowed,
       m.dispense_request_performer_pharmacy_id AS pharmacy_id,
       m.ext_note_to_pharmacist AS note_to_pharmacy, m.ext_dea_schedule AS dea_schedule,
       m.ext_signed_by_user_id AS signed_by, m.ext_signed_at AS signed_at,
       m.meta_version_id AS version, m.ext_safety_checked_at,
       CASE WHEN m.ext_safety_checked_version = m.meta_version_id
            THEN m.ext_safety_checked_at END AS safety_checked_at,
       m.created_at, m.updated_at
FROM clinical.medication_request m
LEFT JOIN clinical.encounter e ON e.id = m.encounter_id
WHERE m.id = :id AND m.intent = 'order'
""")
# A prescription's alerts: its latest check's live DetectedIssues, by ID (as
# fhir_store.prescription_alert_ids orders them, and SignRefused's /alerts/{i} counts them).
_ALERTS = text("""
SELECT i.id, i.code_code AS code, i.severity, i.detail AS message,
       (SELECT x.allergy_intolerance_id FROM clinical.detected_issue_implicated x
         WHERE x.detected_issue_id = i.id AND x.allergy_intolerance_id IS NOT NULL
         ORDER BY x.id LIMIT 1) AS allergy_id,
       (SELECT x.medication_request_id FROM clinical.detected_issue_implicated x
         WHERE x.detected_issue_id = i.id AND x.medication_request_id IS NOT NULL
           AND x.medication_request_id <> :id
         ORDER BY x.id LIMIT 1) AS medication_id,
       g.ext_reason AS override_reason, g.date AS overridden_at, u.id AS overridden_by
FROM clinical.detected_issue i
JOIN clinical.detected_issue_implicated me
  ON me.detected_issue_id = i.id AND me.medication_request_id = :id
LEFT JOIN LATERAL (SELECT y.ext_reason, y.date, y.author_practitioner_id
                     FROM clinical.detected_issue_mitigation y
                    WHERE y.detected_issue_id = i.id ORDER BY y.date, y.id LIMIT 1) g ON true
LEFT JOIN admin.app_user u ON u.practitioner_id = g.author_practitioner_id
WHERE i.identified_date_time = :checked_at
  AND i.status NOT IN ('cancelled', 'entered-in-error')
ORDER BY i.id
""")
_TRANSMISSION = text("""
SELECT status, updated_at, error_message FROM admin.erx_transaction
WHERE medication_request_id = :id AND message_type = 'NewRx' AND direction = 'outbound'
ORDER BY occurred_at DESC, created_at DESC LIMIT 1
""")
_ALERT_PRESCRIPTION = text("""
SELECT m.id FROM clinical.medication_request m
JOIN clinical.detected_issue_implicated x ON x.medication_request_id = m.id
JOIN clinical.detected_issue i ON i.id = x.detected_issue_id
WHERE i.id = :id AND i.identified_date_time = m.ext_safety_checked_at AND m.intent = 'order'
LIMIT 1
""")
_ALLERGIES = text("""
SELECT a.id, a.clinical_status, a.verification_status, a.code_code AS code,
       coalesce(a.code_display, a.code_text, a.code_code) AS name
FROM clinical.allergy_intolerance a
WHERE a.patient_id = :patient AND a.code_system = :rxnorm AND a.code_code IS NOT NULL
ORDER BY a.created_at, a.id
""")
_OTHER_MEDICATIONS = text("""
SELECT m.id, m.status, m.medication_codeable_concept_code AS code,
       coalesce(m.medication_codeable_concept_display, m.medication_codeable_concept_text,
                m.medication_codeable_concept_code) AS name
FROM clinical.medication_request m
WHERE m.subject_patient_id = :patient AND m.id <> :id
  AND m.medication_codeable_concept_system = :rxnorm
  AND m.medication_codeable_concept_code IS NOT NULL AND """ + _ON_THE_LIST + """
ORDER BY coalesce(m.ext_signed_at, m.authored_on, m.created_at), m.id
""")
_INGREDIENTS = text("""
SELECT c.code, p.value FROM admin.concept c
JOIN admin.code_system s ON s.id = c.code_system_id
LEFT JOIN admin.concept_property p ON p.concept_id = c.id AND p.property = 'ingredient'
WHERE s.uri = :rxnorm AND c.code = ANY(:codes)
""")
_NAMES = text("""
SELECT c.code, c.display FROM admin.concept c
JOIN admin.code_system s ON s.id = c.code_system_id
WHERE s.uri = :rxnorm AND c.code = ANY(:codes)
""")
# A legal (official) name, else the first recorded; never a nickname or an old name (as
# eligibility's 270 reads the patient's).
_NEW_RX = text("""
SELECT m.id, m.status, m.intent, m.ext_signed_at,
       m.medication_codeable_concept_system AS system, m.medication_codeable_concept_code AS code,
       m.medication_codeable_concept_display AS display,
       m.medication_codeable_concept_text AS text,
       (SELECT d.text FROM clinical.dosage d WHERE d.medication_request_id = m.id
         ORDER BY d.sequence NULLS LAST, d.id LIMIT 1) AS sig,
       m.dispense_request_quantity_value AS quantity_value,
       m.dispense_request_quantity_unit AS quantity_unit,
       m.dispense_request_expected_supply_duration_value AS days_supply,
       m.dispense_request_number_of_repeats_allowed AS refills,
       m.substitution_allowed_boolean AS substitution_allowed,
       m.ext_dea_schedule AS dea_schedule, m.ext_note_to_pharmacist AS note_to_pharmacy,
       p.birth_date, pn.family AS patient_family, pn.given AS patient_given,
       (SELECT i.value FROM clinical.identifier i
         WHERE i.practitioner_id = m.ext_signed_by_practitioner_id AND i.system = :npi
         ORDER BY i.created_at, i.id LIMIT 1) AS prescriber_npi,
       rn.family AS prescriber_family, rn.given AS prescriber_given,
       ph.ncpdp_id, ph.npi AS pharmacy_npi
FROM clinical.medication_request m
JOIN clinical.patient p ON p.id = m.subject_patient_id
LEFT JOIN LATERAL (SELECT x.family, x.given FROM clinical.human_name x
                    WHERE x.patient_id = p.id
                      AND coalesce(x.use, 'official') NOT IN
                          ('nickname', 'old', 'maiden', 'anonymous')
                    ORDER BY (x.use = 'official') DESC NULLS LAST, x.created_at, x.id
                    LIMIT 1) pn ON true
LEFT JOIN LATERAL (SELECT x.family, x.given FROM clinical.human_name x
                    WHERE x.practitioner_id = m.ext_signed_by_practitioner_id
                      AND coalesce(x.use, 'official') NOT IN
                          ('nickname', 'old', 'maiden', 'anonymous')
                    ORDER BY (x.use = 'official') DESC NULLS LAST, x.created_at, x.id
                    LIMIT 1) rn ON true
LEFT JOIN admin.pharmacy ph ON ph.id = m.dispense_request_performer_pharmacy_id
WHERE m.id = :id
""")
_TRANSMISSION_STATUS = text("""
SELECT status FROM admin.erx_transaction
WHERE medication_request_id = :id AND message_type = 'NewRx' AND direction = 'outbound'
ORDER BY occurred_at DESC, created_at DESC LIMIT 1
""")
_FOR_EVENTS = text("""
SELECT m.subject_patient_id, e.ext_facility_id FROM clinical.medication_request m
LEFT JOIN clinical.encounter e ON e.id = m.encounter_id WHERE m.id = :id
""")


def _drug(r: Any) -> Drug:
    return Drug(system=r.system, code=r.code, display=r.display, text=r.text)


def _entry(r: Any) -> MedicationRow:
    return MedicationRow(id=r.id, patient_id=r.subject_patient_id, intent=r.intent,
                         status=r.status, drug=_drug(r), dosage_text=r.dosage_text, note=r.note,
                         recorded_at=r.recorded_at, recorded_by=r.recorded_by)


async def ingredients(db: AsyncSession, codes: Iterable[str]) -> dict[str, frozenset[str]]:
    """Each RxNorm code's ingredients (its ``ingredient`` properties); a code with none stands
    for itself (an ingredient, or a code the loaded release doesn't have)."""
    wanted = sorted(set(codes))
    found: dict[str, set[str]] = {code: set() for code in wanted}
    if wanted:
        for code, value in (await db.execute(_INGREDIENTS, {"rxnorm": RXNORM,
                                                            "codes": wanted})).all():
            if value:
                found[code].add(value)
    return {code: frozenset(values or {code}) for code, values in found.items()}


async def concept_names(db: AsyncSession, codes: Iterable[str]) -> dict[str, str]:
    wanted = sorted(set(codes))
    if not wanted:
        return {}
    rows = (await db.execute(_NAMES, {"rxnorm": RXNORM, "codes": wanted})).all()
    return {code: display for code, display in rows}


async def new_rx_data(db: AsyncSession, prescription_id: UUID) -> NewRxData | None:
    r = (await db.execute(_NEW_RX, {"id": prescription_id, "npi": NPI})).one_or_none()
    if r is None:
        return None
    return NewRxData(
        prescription_id=r.id, status=r.status, intent=r.intent, signed_at=r.ext_signed_at,
        drug=_drug(r), sig=r.sig, quantity_value=r.quantity_value,
        quantity_unit=r.quantity_unit, days_supply=r.days_supply, refills=r.refills,
        substitution_allowed=r.substitution_allowed, dea_schedule=r.dea_schedule,
        note_to_pharmacy=r.note_to_pharmacy, patient_family=r.patient_family,
        patient_given=tuple(r.patient_given or ()), patient_birth_date=r.birth_date,
        prescriber_npi=r.prescriber_npi, prescriber_family=r.prescriber_family,
        prescriber_given=tuple(r.prescriber_given or ()), pharmacy_ncpdp_id=r.ncpdp_id,
        pharmacy_npi=r.pharmacy_npi)


async def transmission_status(db: AsyncSession, prescription_id: UUID) -> str | None:
    """The NewRx's status; None when the prescription has none (a draft, or not this clinic's)."""
    found: str | None = (await db.execute(_TRANSMISSION_STATUS, {"id": prescription_id})
                         ).scalar_one_or_none()
    return found


async def event_scope(db: AsyncSession, prescription_id: UUID) -> tuple[UUID | None, UUID | None]:
    """(patient, facility) of a prescription, for its events."""
    row = (await db.execute(_FOR_EVENTS, {"id": prescription_id})).one_or_none()
    return (row[0], row[1]) if row is not None else (None, None)


_STORE = fs.SqlFhirStore()


class SqlMedicationRepository:
    async def patient(self, db: AsyncSession, patient_id: UUID) -> PatientRef | None:
        r = (await db.execute(_PATIENT, {"id": patient_id})).one_or_none()
        return PatientRef(r.id, bool(r.merged)) if r is not None else None

    async def encounter(self, db: AsyncSession, encounter_id: UUID) -> EncounterRef | None:
        r = (await db.execute(_ENCOUNTER, {"id": encounter_id})).one_or_none()
        return (EncounterRef(r.id, r.subject_patient_id, r.status, r.ext_facility_id)
                if r is not None else None)

    async def pharmacy_active(self, db: AsyncSession, pharmacy_id: UUID) -> bool | None:
        found: bool | None = (await db.execute(_PHARMACY, {"id": pharmacy_id})
                              ).scalar_one_or_none()
        return found

    async def practitioner_of_user(self, db: AsyncSession, user_id: UUID) -> UUID | None:
        found: UUID | None = (await db.execute(_PRACTITIONER, {"id": user_id})
                              ).scalar_one_or_none()
        return found

    async def dea_schedule(self, db: AsyncSession, drug: Drug) -> str | None:
        if drug.system != RXNORM or not drug.code:
            return None
        found: str | None = (await db.execute(_DEA, {"rxnorm": RXNORM, "code": drug.code})
                             ).scalar_one_or_none()
        return found

    async def known_rxnorm(self, db: AsyncSession, code: str) -> bool:
        """An active concept of the loaded RxNorm release (Anand's terminology tables)."""
        return bool((await db.execute(_KNOWN, {"rxnorm": RXNORM, "code": code})).scalar_one())

    async def medications(self, db: AsyncSession, patient_id: UUID, statuses: Sequence[str], *,
                          limit: int, offset: int) -> list[MedicationRow]:
        rows = (await db.execute(_LIST, {"patient": patient_id, "statuses": list(statuses),
                                         "limit": limit, "offset": offset})).all()
        return [_entry(r) for r in rows]

    async def medication(self, db: AsyncSession, medication_id: UUID) -> MedicationRow | None:
        r = (await db.execute(_ONE_ENTRY, {"id": medication_id})).one_or_none()
        return _entry(r) if r is not None else None

    async def prescription(self, db: AsyncSession, prescription_id: UUID
                           ) -> PrescriptionRow | None:
        r = (await db.execute(_PRESCRIPTION, {"id": prescription_id})).one_or_none()
        if r is None:
            return None
        alerts: tuple[AlertRow, ...] = ()
        if r.ext_safety_checked_at is not None:
            alerts = tuple(AlertRow(
                id=a.id, code=a.code, severity=a.severity, message=a.message,
                allergy_id=a.allergy_id, medication_id=a.medication_id,
                override_reason=a.override_reason, overridden_by=a.overridden_by,
                overridden_at=a.overridden_at)
                for a in (await db.execute(_ALERTS, {"id": r.id,
                                                     "checked_at": r.ext_safety_checked_at})))
        t = (await db.execute(_TRANSMISSION, {"id": r.id})).one_or_none()
        return PrescriptionRow(
            id=r.id, patient_id=r.subject_patient_id, encounter_id=r.encounter_id,
            facility_id=r.facility_id, status=r.status, drug=_drug(r),
            dosage_text=r.dosage_text, quantity_value=r.quantity_value,
            quantity_unit=r.quantity_unit, days_supply=r.days_supply, refills=r.refills,
            substitution_allowed=r.substitution_allowed, pharmacy_id=r.pharmacy_id,
            note_to_pharmacy=r.note_to_pharmacy, dea_schedule=r.dea_schedule,
            signed_by=r.signed_by, signed_at=r.signed_at, version=r.version,
            safety_checked_at=r.safety_checked_at, created_at=r.created_at,
            updated_at=r.updated_at, alerts=alerts,
            transmission=TransmissionRow(t.status, t.updated_at, t.error_message)
            if t is not None else None)

    async def alert_prescription(self, db: AsyncSession, alert_id: UUID) -> UUID | None:
        found: UUID | None = (await db.execute(_ALERT_PRESCRIPTION, {"id": alert_id})
                              ).scalar_one_or_none()
        return found

    async def safety_facts(self, db: AsyncSession, row: PrescriptionRow) -> SafetyFacts:
        allergy_rows = (await db.execute(_ALLERGIES, {"patient": row.patient_id,
                                                      "rxnorm": RXNORM})).all()
        med_rows = (await db.execute(_OTHER_MEDICATIONS, {"patient": row.patient_id,
                                                          "id": row.id,
                                                          "rxnorm": RXNORM})).all()
        drug_code = row.drug.code if row.drug.system == RXNORM else None
        codes = [r.code for r in allergy_rows] + [r.code for r in med_rows]
        found = await ingredients(db, codes + ([drug_code] if drug_code else []))
        drug_ingredients = found.get(drug_code, frozenset()) if drug_code else frozenset()
        names = await concept_names(db, drug_ingredients)
        drug = rules.Drug(
            name=row.drug.display or row.drug.text or row.drug.code or "this drug",
            ingredients=drug_ingredients, ingredient_names=names)
        return SafetyFacts(
            drug=drug,
            allergies=tuple(rules.Allergy(id=r.id, clinical_status=r.clinical_status,
                                          verification_status=r.verification_status,
                                          name=r.name, ingredients=found[r.code])
                            for r in allergy_rows),
            medications=tuple(rules.ListEntry(id=r.id, status=r.status, name=r.name,
                                              ingredients=found[r.code])
                              for r in med_rows))

    # ------------------------------------------------------------------------ writes
    async def record_medication(self, db: AsyncSession, data: fs.MedicationIn) -> UUID:
        return (await _STORE.record_medication(db, data)).id

    async def create_prescription(self, db: AsyncSession, data: fs.PrescriptionIn
                                  ) -> fs.Written:
        return await _STORE.create_prescription(db, data)

    async def update_prescription(self, db: AsyncSession, prescription_id: UUID,
                                  changes: fs.PrescriptionChanges, *, if_version: int
                                  ) -> fs.Written:
        return await _STORE.update_prescription(db, prescription_id, changes,
                                                if_version=if_version)

    async def prescription_entered_in_error(self, db: AsyncSession, prescription_id: UUID,
                                            reason: str, *, if_version: int | None
                                            ) -> fs.Written:
        return await _STORE.prescription_entered_in_error(db, prescription_id,
                                                          fs.Reason(text=reason),
                                                          if_version=if_version)

    async def record_safety_check(self, db: AsyncSession, prescription_id: UUID,
                                  alerts: tuple[fs.AlertIn, ...], *, if_version: int
                                  ) -> fs.SafetyCheckWritten:
        return await _STORE.record_safety_check(db, prescription_id, alerts,
                                                if_version=if_version)

    async def override_alert(self, db: AsyncSession, alert_id: UUID, reason: str
                             ) -> fs.Written:
        return await _STORE.override_alert(db, alert_id, reason)

    async def sign_prescription(self, db: AsyncSession, prescription_id: UUID, *,
                                if_version: int, integration_message_id: UUID | None
                                ) -> fs.Written:
        return await _STORE.sign_prescription(db, prescription_id, if_version=if_version,
                                              integration_message_id=integration_message_id)


async def set_transmission_status(db: AsyncSession, prescription_id: UUID, status: str, *,
                                  message: str | None = None,
                                  vendor_message_id: str | None = None
                                  ) -> fs.TransmissionWritten:
    return await _STORE.set_transmission_status(db, prescription_id, status, message=message,
                                                vendor_message_id=vendor_message_id)
