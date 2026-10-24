"""Shared FHIR datatype tables: Identifier, HumanName, ContactPoint, Address, Annotation,
Dosage.

Each row belongs to exactly one owner resource row (exclusive arc of nullable FKs, enforced by
a generated ``num_nonnulls(...) = 1`` CHECK). Owners expose them through ``children(...)``
relationships, e.g. ``Patient.name``.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Index, Integer, SmallInteger, String, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, FhirChildMixin
from app.db.fhir_types import (boolean, cc, code, date_time, decimal, frange, integer, markdown,
                                owner, period, prim, quantity, ref, ref_display, string)
from app.db.models import systems
from app.db.models.enums import (AddressType, AddressUse, ContactPointSystem, ContactPointUse,
                               IdentifierUse, NameUse, UnitsOfTime)


def _string_list(element: str, length: int = 100):
    return mapped_column(ARRAY(String(length)), nullable=False, default=list,
                         server_default=text("'{}'"),
                         info={"fhir": element, "fhir_type": "string", "many": True})


class Identifier(Base, FhirChildMixin):
    __tablename__ = "identifier"
    fhir_parent = ("patient_id", "practitioner_id", "organization_id", "location_id",
                   "related_person_id", "encounter_id", "coverage_id", "document_reference_id")
    __extra_args__ = (
        # One live identifier value per system per tenant, per kind of owner (MRN, NPI ...).
        # SSN is excluded (A39/issue #13): its value is a salted hash or a masked last-four
        # (ck_identifier_ssn_not_clear_text) - the masked form is *meant* to collide across
        # patients who happen to share the same last four digits, so uniqueness on it isn't a
        # real constraint, it's a bug that would wrongly reject a second patient's masked SSN.
        *[Index(f"uq_identifier_{col[:-3]}_value", "tenant_id", "system", "value", unique=True,
                postgresql_where=text(f"{col} IS NOT NULL AND use IS DISTINCT FROM 'old' AND "
                                      f"system IS DISTINCT FROM '{systems.SSN}'"))
          for col in ("patient_id", "practitioner_id", "organization_id", "location_id",
                      "coverage_id")],
        Index("ix_identifier_value", "tenant_id", "value"),
        # SSNs are never stored in clear: only a salted hash or the masked last four digits.
        CheckConstraint(f"system IS DISTINCT FROM '{systems.SSN}' OR "
                        "value ~ '^(sha256:[0-9a-f]{64}|\\*\\*\\*-\\*\\*-[0-9]{4})$'",
                        name="ssn_not_clear_text"),
        CheckConstraint(f"system IS DISTINCT FROM '{systems.NPI}' OR shri_npi_valid(value)",
                        name="npi_valid"),
    )

    patient_id: Mapped[uuid.UUID | None] = owner("patient", "Patient")
    practitioner_id: Mapped[uuid.UUID | None] = owner("practitioner", "Practitioner")
    organization_id: Mapped[uuid.UUID | None] = owner("organization", "Organization")
    location_id: Mapped[uuid.UUID | None] = owner("location", "Location")
    related_person_id: Mapped[uuid.UUID | None] = owner("related_person", "RelatedPerson")
    encounter_id: Mapped[uuid.UUID | None] = owner("encounter", "Encounter")
    coverage_id: Mapped[uuid.UUID | None] = owner("coverage", "Coverage")
    document_reference_id: Mapped[uuid.UUID | None] = owner("document_reference",
                                                            "DocumentReference")

    use: Mapped[str | None] = code("use", IdentifierUse)
    type_system, type_code, type_display, type_text = cc("type")    # v2-0203: MR, DL, MB, SS
    system: Mapped[str | None] = prim("system", String(300), "uri")
    value: Mapped[str] = string("value", 200, required=True)
    period_start, period_end = period("period")
    assigner_display: Mapped[str | None] = ref_display("assigner")


class HumanName(Base, FhirChildMixin):
    __tablename__ = "human_name"
    fhir_parent = ("patient_id", "practitioner_id", "related_person_id", "patient_contact_id")
    __extra_args__ = (
        CheckConstraint("family IS NOT NULL OR cardinality(given) > 0 OR text IS NOT NULL",
                        name="has_name"),
        Index("ix_human_name_family_trgm", "family", postgresql_using="gin",
              postgresql_ops={"family": "gin_trgm_ops"}),
        Index("ix_human_name_family_lower", "tenant_id", text("lower(family)")),
    )

    patient_id: Mapped[uuid.UUID | None] = owner("patient", "Patient")
    practitioner_id: Mapped[uuid.UUID | None] = owner("practitioner", "Practitioner")
    related_person_id: Mapped[uuid.UUID | None] = owner("related_person", "RelatedPerson")
    patient_contact_id: Mapped[uuid.UUID | None] = owner("patient_contact", "Patient.contact")

    use: Mapped[str | None] = code("use", NameUse)
    text: Mapped[str | None] = string("text", 300)
    family: Mapped[str | None] = string("family", 100)
    given: Mapped[list[str]] = _string_list("given")
    prefix: Mapped[list[str]] = _string_list("prefix", 40)
    suffix: Mapped[list[str]] = _string_list("suffix", 40)
    period_start, period_end = period("period")


class ContactPoint(Base, FhirChildMixin):
    __tablename__ = "contact_point"
    fhir_parent = ("patient_id", "practitioner_id", "practitioner_role_id", "organization_id",
                   "location_id", "related_person_id", "patient_contact_id")
    __extra_args__ = (
        CheckConstraint("rank IS NULL OR rank >= 1", name="rank_positive"),
        CheckConstraint("system <> 'email' OR value ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'",
                        name="email_format"),
        CheckConstraint("system NOT IN ('phone', 'fax', 'sms') OR "
                        "value ~ '^\\+?[0-9 ().-]{7,25}$'", name="phone_format"),
        Index("ix_contact_point_phone", "tenant_id",
              text("regexp_replace(value, '[^0-9]', '', 'g')"),
              postgresql_where=text("system IN ('phone', 'sms')")),
    )

    patient_id: Mapped[uuid.UUID | None] = owner("patient", "Patient")
    practitioner_id: Mapped[uuid.UUID | None] = owner("practitioner", "Practitioner")
    practitioner_role_id: Mapped[uuid.UUID | None] = owner("practitioner_role",
                                                           "PractitionerRole")
    organization_id: Mapped[uuid.UUID | None] = owner("organization", "Organization")
    location_id: Mapped[uuid.UUID | None] = owner("location", "Location")
    related_person_id: Mapped[uuid.UUID | None] = owner("related_person", "RelatedPerson")
    patient_contact_id: Mapped[uuid.UUID | None] = owner("patient_contact", "Patient.contact")

    # cpt-2: a value requires a system, so both are NOT NULL.
    system: Mapped[str] = code("system", ContactPointSystem, required=True)
    value: Mapped[str] = string("value", 254, required=True)
    use: Mapped[str | None] = code("use", ContactPointUse)
    rank: Mapped[int | None] = integer("rank", fhir_type="positiveInt")
    period_start, period_end = period("period")


class Address(Base, FhirChildMixin):
    __tablename__ = "address"
    fhir_parent = ("patient_id", "practitioner_id", "organization_id", "location_id",
                   "related_person_id", "patient_contact_id")
    __extra_args__ = (
        CheckConstraint("country IS DISTINCT FROM 'US' OR state IS NULL OR state ~ '^[A-Z]{2}$'",
                        name="us_state"),
        CheckConstraint("country IS DISTINCT FROM 'US' OR postal_code IS NULL OR "
                        "postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'", name="us_zip"),
        CheckConstraint("cardinality(line) > 0 OR city IS NOT NULL OR postal_code IS NOT NULL "
                        "OR text IS NOT NULL", name="has_content"),
        # Location.address is 0..1
        Index("uq_address_location", "location_id", unique=True,
              postgresql_where=text("location_id IS NOT NULL")),
        Index("uq_address_patient_contact", "patient_contact_id", unique=True,
              postgresql_where=text("patient_contact_id IS NOT NULL")),
    )

    patient_id: Mapped[uuid.UUID | None] = owner("patient", "Patient")
    practitioner_id: Mapped[uuid.UUID | None] = owner("practitioner", "Practitioner")
    organization_id: Mapped[uuid.UUID | None] = owner("organization", "Organization")
    location_id: Mapped[uuid.UUID | None] = owner("location", "Location")
    related_person_id: Mapped[uuid.UUID | None] = owner("related_person", "RelatedPerson")
    patient_contact_id: Mapped[uuid.UUID | None] = owner("patient_contact", "Patient.contact")

    use: Mapped[str | None] = code("use", AddressUse)
    type: Mapped[str | None] = code("type", AddressType)
    text: Mapped[str | None] = string("text", 500)
    line: Mapped[list[str]] = _string_list("line", 200)
    city: Mapped[str | None] = string("city", 100)
    district: Mapped[str | None] = string("district", 100)
    state: Mapped[str | None] = string("state", 50)
    postal_code: Mapped[str | None] = string("postalCode", 20)
    country: Mapped[str | None] = string("country", 2)
    period_start, period_end = period("period")


class Annotation(Base, FhirChildMixin):
    """Annotation (``note``) of a clinical resource."""
    __tablename__ = "annotation"
    __fhir_choices__ = {"author": (False, ["authorReference", "authorString"])}
    fhir_parent = ("condition_id", "allergy_intolerance_id", "observation_id", "procedure_id",
                   "medication_request_id", "medication_statement_id", "service_request_id",
                   "immunization_id", "family_member_history_id", "specimen_id")

    condition_id: Mapped[uuid.UUID | None] = owner("condition", "Condition")
    allergy_intolerance_id: Mapped[uuid.UUID | None] = owner("allergy_intolerance",
                                                             "AllergyIntolerance")
    observation_id: Mapped[uuid.UUID | None] = owner("observation", "Observation")
    procedure_id: Mapped[uuid.UUID | None] = owner("procedure", "Procedure")
    medication_request_id: Mapped[uuid.UUID | None] = owner("medication_request",
                                                            "MedicationRequest")
    medication_statement_id: Mapped[uuid.UUID | None] = owner("medication_statement",
                                                              "MedicationStatement")
    service_request_id: Mapped[uuid.UUID | None] = owner("service_request", "ServiceRequest")
    immunization_id: Mapped[uuid.UUID | None] = owner("immunization", "Immunization")
    family_member_history_id: Mapped[uuid.UUID | None] = owner("family_member_history",
                                                               "FamilyMemberHistory")
    specimen_id: Mapped[uuid.UUID | None] = owner("specimen", "Specimen")

    author_practitioner_id: Mapped[uuid.UUID | None] = ref("authorReference", "practitioner",
                                                           "Practitioner")
    author_patient_id: Mapped[uuid.UUID | None] = ref("authorReference", "patient", "Patient")
    author_related_person_id: Mapped[uuid.UUID | None] = ref("authorReference", "related_person",
                                                             "RelatedPerson")
    author_string: Mapped[str | None] = string("authorString", 200)
    time: Mapped[datetime | None] = date_time("time")
    text: Mapped[str] = markdown("text", required=True)


class Dosage(Base, FhirChildMixin):
    """Dosage (MedicationRequest.dosageInstruction, MedicationStatement.dosage,
    MedicationDispense.dosageInstruction). One doseAndRate entry is modelled."""
    __tablename__ = "dosage"
    __fhir_choices__ = {
        "asNeeded": (False, ["asNeededBoolean", "asNeededCodeableConcept"]),
        "doseAndRate.dose": (False, ["doseAndRate.doseQuantity", "doseAndRate.doseRange"]),
    }
    __fhir_lists__ = {"doseAndRate"}
    fhir_parent = ("medication_request_id", "medication_statement_id", "medication_dispense_id")
    __extra_args__ = (
        CheckConstraint("sequence IS NULL OR sequence >= 1", name="sequence_positive"),
        CheckConstraint("timing_repeat_frequency IS NULL OR timing_repeat_frequency >= 1",
                        name="frequency_positive"),
        CheckConstraint("(timing_repeat_period IS NULL) = (timing_repeat_period_unit IS NULL)",
                        name="tim_1_period_unit"),              # FHIR tim-1
        CheckConstraint("timing_repeat_period IS NULL OR timing_repeat_period > 0",
                        name="period_positive"),
        CheckConstraint("dose_and_rate_dose_quantity_value IS NULL OR "
                        "dose_and_rate_dose_quantity_value > 0", name="dose_positive"),
    )

    medication_request_id: Mapped[uuid.UUID | None] = owner("medication_request",
                                                            "MedicationRequest")
    medication_statement_id: Mapped[uuid.UUID | None] = owner("medication_statement",
                                                              "MedicationStatement")
    medication_dispense_id: Mapped[uuid.UUID | None] = owner("medication_dispense",
                                                             "MedicationDispense")

    sequence: Mapped[int | None] = integer("sequence")
    text: Mapped[str | None] = string("text", 1000)               # the sig
    patient_instruction: Mapped[str | None] = string("patientInstruction", 1000)
    timing_code_system, timing_code_code, timing_code_display, timing_code_text = cc(
        "timing.code")                                             # BID, TID, Q4H ...
    timing_repeat_frequency: Mapped[int | None] = integer("timing.repeat.frequency",
                                                          fhir_type="positiveInt")
    timing_repeat_period: Mapped[Decimal | None] = decimal("timing.repeat.period")
    timing_repeat_period_unit: Mapped[str | None] = code("timing.repeat.periodUnit", UnitsOfTime)
    (timing_repeat_bounds_duration_value, timing_repeat_bounds_duration_unit,
     timing_repeat_bounds_duration_system, timing_repeat_bounds_duration_code) = quantity(
        "timing.repeat.boundsDuration", comparator=False, fhir_type="Duration")
    as_needed_boolean: Mapped[bool | None] = boolean("asNeededBoolean")
    (as_needed_codeable_concept_system, as_needed_codeable_concept_code,
     as_needed_codeable_concept_display, as_needed_codeable_concept_text) = cc(
        "asNeededCodeableConcept")
    site_system, site_code, site_display, site_text = cc("site")
    route_system, route_code, route_display, route_text = cc("route")
    method_system, method_code, method_display, method_text = cc("method")
    (dose_and_rate_dose_quantity_value, dose_and_rate_dose_quantity_unit,
     dose_and_rate_dose_quantity_system, dose_and_rate_dose_quantity_code) = quantity(
        "doseAndRate.doseQuantity", comparator=False, fhir_type="Quantity")
    (dose_and_rate_dose_range_low_value, dose_and_rate_dose_range_low_unit,
     dose_and_rate_dose_range_low_code, dose_and_rate_dose_range_high_value,
     dose_and_rate_dose_range_high_unit, dose_and_rate_dose_range_high_code) = frange(
        "doseAndRate.doseRange")
