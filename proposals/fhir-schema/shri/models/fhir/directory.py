"""Patient, RelatedPerson, Practitioner, PractitionerRole, Organization, Location (US Core)."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, Index, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from shri.db.base import Base, ClinicalResourceMixin, FhirChildMixin, FhirResourceMixin, enum_type
from shri.db.fhir_types import (boolean, cc, children, code, coding, date_period, date_time,
                                fdate, identifier, integer, parent, period, ref, ref_display,
                                string)
from shri.models import systems
from shri.models.enums import (AdministrativeGender, BedStatus, BirthSex, LinkType,
                               LocationMode, LocationStatus, RaceEthnicityKind,
                               RaceEthnicityLevel)

US_CORE_BIRTHSEX = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex"
OMB_RACE = "'1002-5', '2028-9', '2054-5', '2076-8', '2106-3', 'UNK', 'ASKU'"
OMB_ETHNICITY = "'2135-2', '2186-5', 'UNK', 'ASKU'"


def _shared(owner_fk: str, *, name: bool = True, address: bool = True,
            identifier_: bool = True) -> dict:
    rels = {"telecom": children("ContactPoint", owner_fk, "telecom", order_by="rank")}
    if identifier_:
        rels["identifier"] = children("Identifier", owner_fk, "identifier")
    if name:
        rels["name"] = children("HumanName", owner_fk, "name")
    if address:
        rels["address"] = children("Address", owner_fk, "address")
    return rels


# =========================================================================== Patient
class Patient(Base, ClinicalResourceMixin):
    """US Core Patient. MRN, driver's licence (AAMVA scan), payer member IDs and OpenEMR pubpid
    are rows in ``identifier``. A restricted / VIP chart is ``meta_security`` R or V
    (break-the-glass to open)."""
    __tablename__ = "patient"
    fhir_type = "Patient"
    __fhir_choices__ = {
        "deceased": (False, ["deceasedBoolean", "deceasedDateTime"]),
        "multipleBirth": (False, ["multipleBirthBoolean", "multipleBirthInteger"]),
    }
    __extra_args__ = (
        Index("ix_patient_birth_date", "tenant_id", "birth_date"),
        CheckConstraint("birth_date IS NULL OR birth_date <= CURRENT_DATE + 1",
                        name="birth_date_not_future"),
        CheckConstraint("deceased_date_time IS NULL OR birth_date IS NULL OR "
                        "deceased_date_time::date >= birth_date", name="deceased_after_birth"),
        CheckConstraint("multiple_birth_integer IS NULL OR multiple_birth_integer >= 1",
                        name="birth_order"),
    )

    active: Mapped[bool] = boolean("active", required=True, default=True,
                                   server_default=text("true"))
    gender: Mapped[str] = code("gender", AdministrativeGender, required=True)
    birth_date: Mapped[date | None] = fdate("birthDate")
    deceased_boolean: Mapped[bool | None] = boolean("deceasedBoolean")
    deceased_date_time: Mapped[datetime | None] = date_time("deceasedDateTime")
    marital_status_system, marital_status_code, marital_status_display, marital_status_text = \
        cc("maritalStatus")
    multiple_birth_boolean: Mapped[bool | None] = boolean("multipleBirthBoolean")
    multiple_birth_integer: Mapped[int | None] = integer("multipleBirthInteger")
    managing_organization_id: Mapped[uuid.UUID | None] = ref(
        "managingOrganization", "organization", "Organization")
    # US Core extensions (race / ethnicity detail rows in patient_race_ethnicity)
    ext_birthsex: Mapped[str | None] = mapped_column(
        enum_type(BirthSex), info={"fhir_ext": US_CORE_BIRTHSEX, "fhir_type": "code"})
    ext_race_text: Mapped[str | None] = mapped_column(String(200))
    ext_ethnicity_text: Mapped[str | None] = mapped_column(String(200))

    locals().update(_shared("patient_id"))
    contact = children("PatientContact", "patient_id", "contact")
    communication = children("PatientCommunication", "patient_id", "communication")
    general_practitioner = children("PatientGeneralPractitioner", "patient_id", None,
                                    spread=True)
    link = children("PatientLink", "patient_id", "link")
    race_ethnicity = children("PatientRaceEthnicity", "patient_id", None)


class PatientContact(Base, FhirChildMixin):
    """Patient.contact (emergency contact, next of kin) - pat-1 is checked by the API."""
    __tablename__ = "patient_contact"
    fhir_parent = ("patient_id",)

    patient_id: Mapped[uuid.UUID] = parent("patient")
    relationship_system, relationship_code, relationship_display, relationship_text = cc(
        "relationship", many=True)                     # v2-0131: C, E, N ...
    gender: Mapped[str | None] = code("gender", AdministrativeGender)
    organization_id: Mapped[uuid.UUID | None] = ref("organization", "organization",
                                                    "Organization")
    period_start, period_end = period("period")

    name = children("HumanName", "patient_contact_id", "name", single=True)
    telecom = children("ContactPoint", "patient_contact_id", "telecom", order_by="rank")
    address = children("Address", "patient_contact_id", "address", single=True)


class PatientCommunication(Base, FhirChildMixin):
    __tablename__ = "patient_communication"
    fhir_parent = ("patient_id",)
    __extra_args__ = (
        UniqueConstraint("patient_id", "language_code"),
        Index("uq_patient_communication_one_preferred", "patient_id", unique=True,
              postgresql_where=text("preferred")),
    )

    patient_id: Mapped[uuid.UUID] = parent("patient")
    language_system, language_code, language_display, language_text = cc("language",
                                                                         required=True)
    preferred: Mapped[bool | None] = boolean("preferred")


class PatientGeneralPractitioner(Base, FhirChildMixin):
    __tablename__ = "patient_general_practitioner"
    fhir_parent = ("patient_id",)

    patient_id: Mapped[uuid.UUID] = parent("patient")
    practitioner_id: Mapped[uuid.UUID | None] = ref("generalPractitioner", "practitioner",
                                                    "Practitioner", required=True)
    organization_id: Mapped[uuid.UUID | None] = ref("generalPractitioner", "organization",
                                                    "Organization", required=True)
    practitioner_role_id: Mapped[uuid.UUID | None] = ref(
        "generalPractitioner", "practitioner_role", "PractitionerRole", required=True)


class PatientLink(Base, FhirChildMixin):
    """Merge / duplicate links. A merged chart carries 'replaced-by' the surviving one."""
    __tablename__ = "patient_link"
    fhir_parent = ("patient_id",)
    __extra_args__ = (
        CheckConstraint("other_patient_id IS DISTINCT FROM patient_id", name="not_self"),
        UniqueConstraint("patient_id", "other_patient_id", "type"),
    )

    patient_id: Mapped[uuid.UUID] = parent("patient")
    other_patient_id: Mapped[uuid.UUID | None] = ref("other", "patient", "Patient",
                                                     required=True)
    other_related_person_id: Mapped[uuid.UUID | None] = ref("other", "related_person",
                                                            "RelatedPerson", required=True)
    type: Mapped[str] = code("type", LinkType, required=True)


class PatientRaceEthnicity(Base, FhirChildMixin):
    """US Core race / ethnicity extension codes (CDC Race & Ethnicity). OMB categories are
    restricted to the OMB code list."""
    __tablename__ = "patient_race_ethnicity"
    fhir_parent = ("patient_id",)
    __extra_args__ = (
        UniqueConstraint("patient_id", "kind", "code"),
        CheckConstraint(f"NOT (kind = 'race' AND level = 'ombCategory') OR code IN ({OMB_RACE})",
                        name="omb_race"),
        CheckConstraint(f"NOT (kind = 'ethnicity' AND level = 'ombCategory') OR "
                        f"code IN ({OMB_ETHNICITY})", name="omb_ethnicity"),
    )

    patient_id: Mapped[uuid.UUID] = parent("patient")
    kind: Mapped[str] = mapped_column(enum_type(RaceEthnicityKind), nullable=False)
    level: Mapped[str] = mapped_column(enum_type(RaceEthnicityLevel), nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    display: Mapped[str | None] = mapped_column(String(200))


# =========================================================================== RelatedPerson
class RelatedPerson(Base, FhirResourceMixin):
    """Emergency contacts, guarantors (GUAR), guardians, insurance subscribers."""
    __tablename__ = "related_person"
    fhir_type = "RelatedPerson"

    patient_id: Mapped[uuid.UUID] = ref("patient", "patient", "Patient", required=True,
                                        index=True)
    active: Mapped[bool] = boolean("active", required=True, default=True,
                                   server_default=text("true"))
    gender: Mapped[str | None] = code("gender", AdministrativeGender)
    birth_date: Mapped[date | None] = fdate("birthDate")
    period_start, period_end = period("period")

    locals().update(_shared("related_person_id"))
    relationship = children("RelatedPersonRelationship", "related_person_id", "relationship")


class RelatedPersonRelationship(Base, FhirChildMixin):
    __tablename__ = "related_person_relationship"
    fhir_parent = ("related_person_id",)
    __extra_args__ = (UniqueConstraint("related_person_id", "code_system", "code_code"),)

    related_person_id: Mapped[uuid.UUID] = parent("related_person")
    code_system, code_code, code_display, code_text = cc(".", required=True)  # the CC itself


# =========================================================================== Practitioner
class Practitioner(Base, FhirResourceMixin):
    """US Core Practitioner. NPI is an identifier (system us-npi), validated and unique per
    tenant. DEA numbers are OpenBao references only."""
    __tablename__ = "practitioner"
    fhir_type = "Practitioner"

    active: Mapped[bool] = boolean("active", required=True, default=True,
                                   server_default=text("true"))
    gender: Mapped[str | None] = code("gender", AdministrativeGender)
    birth_date: Mapped[date | None] = fdate("birthDate")
    ext_dea_number_ref: Mapped[str | None] = mapped_column(String(200))

    locals().update(_shared("practitioner_id"))
    qualification = children("PractitionerQualification", "practitioner_id", "qualification")


class PractitionerQualification(Base, FhirChildMixin):
    """Degrees and state licences (license number, state, period)."""
    __tablename__ = "practitioner_qualification"
    fhir_parent = ("practitioner_id",)
    __extra_args__ = (
        CheckConstraint("ext_state IS NULL OR ext_state ~ '^[A-Z]{2}$'", name="state_format"),
        CheckConstraint("period_end IS NULL OR period_start IS NULL OR period_end >= period_start",
                        name="period"),
    )

    practitioner_id: Mapped[uuid.UUID] = parent("practitioner")
    identifier_system, identifier_value = identifier("identifier")
    code_system, code_code, code_display, code_text = cc("code", required=True)
    period_start, period_end = date_period("period")
    issuer_display: Mapped[str | None] = ref_display("issuer")
    ext_state: Mapped[str | None] = mapped_column(String(2))


class PractitionerRole(Base, FhirResourceMixin):
    __tablename__ = "practitioner_role"
    fhir_type = "PractitionerRole"

    active: Mapped[bool] = boolean("active", required=True, default=True,
                                   server_default=text("true"))
    period_start, period_end = period("period")
    practitioner_id: Mapped[uuid.UUID] = ref("practitioner", "practitioner", "Practitioner",
                                             required=True, index=True)
    organization_id: Mapped[uuid.UUID | None] = ref("organization", "organization",
                                                    "Organization")
    code_system, code_code, code_display, code_text = cc("code", many=True)

    telecom = children("ContactPoint", "practitioner_role_id", "telecom", order_by="rank")
    specialty = children("PractitionerRoleSpecialty", "practitioner_role_id", None, spread=True)
    location = children("PractitionerRoleLocation", "practitioner_role_id", None, spread=True)


class PractitionerRoleSpecialty(Base, FhirChildMixin):
    __tablename__ = "practitioner_role_specialty"
    fhir_parent = ("practitioner_role_id",)
    __extra_args__ = (UniqueConstraint("practitioner_role_id", "specialty_code"),)

    practitioner_role_id: Mapped[uuid.UUID] = parent("practitioner_role")
    specialty_system, specialty_code, specialty_display, specialty_text = cc(
        "specialty", required=True, many=True)        # NUCC taxonomy


class PractitionerRoleLocation(Base, FhirChildMixin):
    __tablename__ = "practitioner_role_location"
    fhir_parent = ("practitioner_role_id",)
    __extra_args__ = (UniqueConstraint("practitioner_role_id", "location_id"),)

    practitioner_role_id: Mapped[uuid.UUID] = parent("practitioner_role")
    location_id: Mapped[uuid.UUID] = ref("location", "location", "Location", required=True)


# =========================================================================== Organization
class Organization(Base, FhirResourceMixin):
    """The practice itself (tenant.organization_id), external practices, imaging centres,
    labs. Payers and pharmacies are platform directories (payer, pharmacy)."""
    __tablename__ = "organization"
    fhir_type = "Organization"
    __extra_args__ = (CheckConstraint("part_of_organization_id IS DISTINCT FROM id",
                                      name="not_part_of_self"),)

    active: Mapped[bool] = boolean("active", required=True, default=True,
                                   server_default=text("true"))
    type_system, type_code, type_display, type_text = cc("type", many=True)  # prov, dept, ...
    name: Mapped[str] = string("name", 200, required=True)
    part_of_organization_id: Mapped[uuid.UUID | None] = ref("partOf", "organization",
                                                            "Organization")

    locals().update(_shared("organization_id", name=False))


# =========================================================================== Location
class Location(Base, FhirResourceMixin):
    """Sites, buildings and exam rooms (rooming). A site's billing attributes are in the
    admin ``facility`` table."""
    __tablename__ = "location"
    fhir_type = "Location"
    __extra_args__ = (
        CheckConstraint("part_of_location_id IS DISTINCT FROM id", name="not_part_of_self"),
        Index("ix_location_part_of", "part_of_location_id"),
    )

    status: Mapped[str | None] = code("status", LocationStatus, default=LocationStatus.ACTIVE)
    operational_status: Mapped[str | None] = coding("operationalStatus",
                                                    fixed_system=systems.V2_0116,
                                                    enum_cls=BedStatus)
    name: Mapped[str] = string("name", 200, required=True)
    description: Mapped[str | None] = string("description", 500)
    mode: Mapped[str | None] = code("mode", LocationMode, default=LocationMode.INSTANCE)
    type_system, type_code, type_display, type_text = cc("type", many=True)
    (physical_type_system, physical_type_code, physical_type_display,
     physical_type_text) = cc("physicalType")              # si, bu, ro ...
    managing_organization_id: Mapped[uuid.UUID | None] = ref(
        "managingOrganization", "organization", "Organization")
    part_of_location_id: Mapped[uuid.UUID | None] = ref("partOf", "location", "Location")

    identifier = children("Identifier", "location_id", "identifier")
    telecom = children("ContactPoint", "location_id", "telecom", order_by="rank")
    address = children("Address", "location_id", "address", single=True)
