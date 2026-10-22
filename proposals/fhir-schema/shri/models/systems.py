"""Code system URIs. ``SEED`` is loaded into ``code_system`` by the baseline migration; every
CodeableConcept ``*_system`` column references ``code_system.uri``, so a system must be
registered here (or by a platform job) before codes from it can be stored.

CPT content needs an AMA licence and SNOMED CT US Edition a UMLS licence (ADR-18): the
*systems* are registered here, the concept content is loaded per deployment.
"""
SHRI = "https://shri.health/fhir"
SHRI_CS = f"{SHRI}/CodeSystem"
SHRI_EXT = f"{SHRI}/StructureDefinition"

# HL7 / FHIR
CONDITION_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical"
CONDITION_VER_STATUS = "http://terminology.hl7.org/CodeSystem/condition-ver-status"
CONDITION_CATEGORY = "http://terminology.hl7.org/CodeSystem/condition-category"
US_CORE_CATEGORY = "http://hl7.org/fhir/us/core/CodeSystem/us-core-category"
ALLERGY_CLINICAL = "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical"
ALLERGY_VERIFICATION = "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification"
OBSERVATION_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category"
INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation"
DATA_ABSENT_REASON = "http://terminology.hl7.org/CodeSystem/data-absent-reason"
V3_ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode"
V3_ROLE_CODE = "http://terminology.hl7.org/CodeSystem/v3-RoleCode"
V3_PARTICIPATION_TYPE = "http://terminology.hl7.org/CodeSystem/v3-ParticipationType"
V3_CONFIDENTIALITY = "http://terminology.hl7.org/CodeSystem/v3-Confidentiality"
V3_NULL_FLAVOR = "http://terminology.hl7.org/CodeSystem/v3-NullFlavor"
V3_DATA_OPERATION = "http://terminology.hl7.org/CodeSystem/v3-DataOperation"
V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203"      # identifier type
V2_0074 = "http://terminology.hl7.org/CodeSystem/v2-0074"      # diagnostic service section
V2_0116 = "http://terminology.hl7.org/CodeSystem/v2-0116"      # bed status
V2_0131 = "http://terminology.hl7.org/CodeSystem/v2-0131"      # contact role
V2_0360 = "http://terminology.hl7.org/CodeSystem/v2-0360"      # degree / license
DIAGNOSIS_ROLE = "http://terminology.hl7.org/CodeSystem/diagnosis-role"
ENCOUNTER_PARTICIPANT_TYPE = V3_PARTICIPATION_TYPE
LOCATION_PHYSICAL_TYPE = "http://terminology.hl7.org/CodeSystem/location-physical-type"
ORGANIZATION_TYPE = "http://terminology.hl7.org/CodeSystem/organization-type"
MEDREQ_CATEGORY = "http://terminology.hl7.org/CodeSystem/medicationrequest-category"
MED_STATEMENT_CATEGORY = "http://terminology.hl7.org/CodeSystem/medication-statement-category"
DOSE_RATE_TYPE = "http://terminology.hl7.org/CodeSystem/dose-rate-type"
CONSENT_SCOPE = "http://terminology.hl7.org/CodeSystem/consentscope"
CONSENT_CATEGORY = "http://terminology.hl7.org/CodeSystem/consentcategorycodes"
CONSENT_POLICY = "http://terminology.hl7.org/CodeSystem/consentpolicycodes"
COVERAGE_CLASS = "http://terminology.hl7.org/CodeSystem/coverage-class"
SUBSCRIBER_RELATIONSHIP = "http://terminology.hl7.org/CodeSystem/subscriber-relationship"
COVERAGE_COPAY_TYPE = "http://terminology.hl7.org/CodeSystem/coverage-copay-type"
PAYER_TYPOLOGY = "urn:oid:2.16.840.1.113883.3.221.5"           # SOP payer typology
PROVENANCE_AGENT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type"
DETECTED_ISSUE_CATEGORY = V3_ACT_CODE
DETECTED_ISSUE_MITIGATION = V3_ACT_CODE
ACT_REASON = "http://terminology.hl7.org/CodeSystem/v3-ActReason"
FAMILY_MEMBER = V3_ROLE_CODE
APPOINTMENT_REASON = "http://terminology.hl7.org/CodeSystem/v2-0276"
CANCEL_REASON = "http://terminology.hl7.org/CodeSystem/appointment-cancellation-reason"
SPECIMEN_TYPE_V2 = "http://terminology.hl7.org/CodeSystem/v2-0487"
LANGUAGE = "urn:ietf:bcp:47"
RACE_ETHNICITY = "urn:oid:2.16.840.1.113883.6.238"             # CDC Race & Ethnicity
MARITAL_STATUS = "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus"
DOC_CLASS = "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category"
IMMUNIZATION_ORIGIN = "http://terminology.hl7.org/CodeSystem/immunization-origin"

# Terminologies
ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm"
SNOMED = "http://snomed.info/sct"
LOINC = "http://loinc.org"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
NDC = "http://hl7.org/fhir/sid/ndc"
CPT = "http://www.ama-assn.org/go/cpt"
HCPCS = "urn:oid:2.16.840.1.113883.6.285"
CVX = "http://hl7.org/fhir/sid/cvx"
NUCC = "http://nucc.org/provider-taxonomy"
CMS_POS = "https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code_Set"
UNII = "http://fdasis.nlm.nih.gov"
NCI = "http://ncithesaurus-stage.nci.nih.gov"
UCUM = "http://unitsofmeasure.org"

# Identifier systems (not CodeSystems: used in identifier.system, no FK)
NPI = "http://hl7.org/fhir/sid/us-npi"
SSN = "http://hl7.org/fhir/sid/us-ssn"
MEDICARE_MBI = "http://hl7.org/fhir/sid/us-mbi"

# Shri local code systems
SHRI_ENTRY_SOURCE = f"{SHRI_CS}/entry-source"
SHRI_CONSENT_KIND = f"{SHRI_CS}/consent-kind"
SHRI_APPOINTMENT_TYPE = f"{SHRI_CS}/appointment-type"
SHRI_NOTE_SECTION = f"{SHRI_CS}/note-section"
SHRI_LOCAL = f"{SHRI_CS}/local"          # tenant picklists (picklist_item codes)
SHRI_ALERT_RULE = f"{SHRI_CS}/cds-rule"

SEED: list[tuple[str, str, str]] = [
    # (short code, uri, name)
    ("ICD10CM", ICD10CM, "ICD-10-CM"),
    ("SNOMEDCT", SNOMED, "SNOMED CT US Edition"),
    ("LOINC", LOINC, "LOINC"),
    ("RXNORM", RXNORM, "RxNorm"),
    ("NDC", NDC, "National Drug Code"),
    ("CPT", CPT, "CPT (AMA licence required)"),
    ("HCPCS", HCPCS, "HCPCS Level II"),
    ("CVX", CVX, "CDC vaccine codes"),
    ("NUCC", NUCC, "NUCC provider taxonomy"),
    ("CMSPOS", CMS_POS, "CMS place of service"),
    ("UNII", UNII, "FDA UNII"),
    ("NCI", NCI, "NCI Thesaurus"),
    ("CDCREC", RACE_ETHNICITY, "CDC Race and Ethnicity"),
    ("BCP47", LANGUAGE, "IETF language tags"),
    ("COND-CLIN", CONDITION_CLINICAL, "Condition clinical status"),
    ("COND-VER", CONDITION_VER_STATUS, "Condition verification status"),
    ("COND-CAT", CONDITION_CATEGORY, "Condition category"),
    ("USCORE-CAT", US_CORE_CATEGORY, "US Core category"),
    ("AI-CLIN", ALLERGY_CLINICAL, "AllergyIntolerance clinical status"),
    ("AI-VER", ALLERGY_VERIFICATION, "AllergyIntolerance verification status"),
    ("OBS-CAT", OBSERVATION_CATEGORY, "Observation category"),
    ("OBS-INTERP", INTERPRETATION, "Observation interpretation"),
    ("DAR", DATA_ABSENT_REASON, "Data absent reason"),
    ("V3-ACT", V3_ACT_CODE, "v3 ActCode"),
    ("V3-ROLE", V3_ROLE_CODE, "v3 RoleCode"),
    ("V3-PART", V3_PARTICIPATION_TYPE, "v3 ParticipationType"),
    ("V3-CONF", V3_CONFIDENTIALITY, "v3 Confidentiality"),
    ("V3-NULL", V3_NULL_FLAVOR, "v3 NullFlavor"),
    ("V3-DATAOP", V3_DATA_OPERATION, "v3 DataOperation"),
    ("V3-REASON", ACT_REASON, "v3 ActReason"),
    ("V3-MARITAL", MARITAL_STATUS, "v3 MaritalStatus"),
    ("V2-0203", V2_0203, "v2 identifier type"),
    ("V2-0074", V2_0074, "v2 diagnostic service section"),
    ("V2-0116", V2_0116, "v2 bed status"),
    ("V2-0131", V2_0131, "v2 contact role"),
    ("V2-0276", APPOINTMENT_REASON, "v2 appointment reason"),
    ("V2-0360", V2_0360, "v2 degree/license"),
    ("V2-0487", SPECIMEN_TYPE_V2, "v2 specimen type"),
    ("DX-ROLE", DIAGNOSIS_ROLE, "Diagnosis role"),
    ("LOC-PHYS", LOCATION_PHYSICAL_TYPE, "Location physical type"),
    ("ORG-TYPE", ORGANIZATION_TYPE, "Organization type"),
    ("MEDREQ-CAT", MEDREQ_CATEGORY, "MedicationRequest category"),
    ("MEDSTMT-CAT", MED_STATEMENT_CATEGORY, "MedicationStatement category"),
    ("DOSE-RATE", DOSE_RATE_TYPE, "Dose and rate type"),
    ("CONSENT-SCOPE", CONSENT_SCOPE, "Consent scope"),
    ("CONSENT-CAT", CONSENT_CATEGORY, "Consent category"),
    ("CONSENT-POLICY", CONSENT_POLICY, "Consent policy"),
    ("COV-CLASS", COVERAGE_CLASS, "Coverage class"),
    ("SUB-REL", SUBSCRIBER_RELATIONSHIP, "Subscriber relationship"),
    ("COV-COPAY", COVERAGE_COPAY_TYPE, "Coverage copay type"),
    ("SOP", PAYER_TYPOLOGY, "Source of payment typology"),
    ("PROV-AGENT", PROVENANCE_AGENT_TYPE, "Provenance participant type"),
    ("CANCEL-REASON", CANCEL_REASON, "Appointment cancellation reason"),
    ("USCORE-DOC", DOC_CLASS, "US Core DocumentReference category"),
    ("IMM-ORIGIN", IMMUNIZATION_ORIGIN, "Immunization origin"),
    ("SHRI-ENTRY", SHRI_ENTRY_SOURCE, "Shri entry source"),
    ("SHRI-CONSENT", SHRI_CONSENT_KIND, "Shri consent kind"),
    ("SHRI-APPT", SHRI_APPOINTMENT_TYPE, "Shri appointment type"),
    ("SHRI-SECTION", SHRI_NOTE_SECTION, "Shri note section"),
    ("SHRI-LOCAL", SHRI_LOCAL, "Shri tenant picklists"),
    ("SHRI-CDS", SHRI_ALERT_RULE, "Shri CDS rules"),
]
