"""Facility scope of every patients operation, against the live database (SECURITY_MODEL §5.1,
D37). The patient record and everything hanging off it here (identifiers, related persons,
coverages, consents) has no facility: it follows §5.1's patient row and is clinic-wide by design,
so a user at facility A1 finds a patient seen only at facility A2 (the rows say so). The
pre-registration queue is the clinic's, with no facility either (D96). Clinic B gets 404 for every
ID of clinic A, and its lists and searches show none of them (RLS). One table, every operation
the module serves (scheduling's facility_scope.py runs it). Synthetic data only."""

from __future__ import annotations

import hashlib
import uuid
from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import (  # noqa: F401  (fixtures)
    Practice,
    client,
    practice,
    users,
)
from app.modules.scheduling.tests.facility_scope import (
    API,
    Row,
    appointment_today,
    failures,
    report,
    served_operations,
    staff,
    sweep,
)
from app.modules.scheduling.tests.test_check_in_live import _check_in, _sql

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

MERGE = {"Content-Type": "application/merge-patch+json"}
BY_DESIGN = "patient-level, clinic-wide by design (§5.1 patient row)"
#: Operations with no record ID to scope, and why.
NO_RECORD_ID = {
    "registerPatient": "creates a patient; takes no record ID (the clinic is the session's)",
    "submitPreRegistration": "the public form: no user; the clinic comes from the link (D96)",
}
RELATIVE = {"name": {"family": "Lindgren118", "given": ["Signe77"]},
            "relationships": [{"system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                               "code": "EMC", "display": "emergency contact"}]}
CONSENT = {"kind": "treatment", "decision": "permit", "signatureMethod": "electronic",
           "signedAt": "2026-11-03T15:05:00Z", "policyVersion": "2026-10"}


def _payer(p: Practice) -> str:
    payer = uuid.uuid4()
    _sql(p, "INSERT INTO admin.payer (id, name, payer_type, supports_eligibility, "
         "supports_claim_status, supports_era, is_active) VALUES (:i, 'Scope Health Plan "
         "(synthetic)', 'commercial', true, true, true, true)", i=payer)
    _sql(p, "INSERT INTO admin.practice_payer (id, tenant_id, payer_id, is_active) "
         "VALUES (gen_random_uuid(), :t, :p, true)", t=p.clinic, p=payer)
    return str(payer)


def _pharmacy(p: Practice) -> str:
    """A pharmacy in the platform directory (synthetic; the directory has no clinic)."""
    pharmacy = uuid.uuid4()
    _sql(p, "INSERT INTO admin.pharmacy (id, ncpdp_id, name, is_mail_order, is_active) "
         "VALUES (:i, :n, 'Scope Pharmacy (synthetic)', false, true)", i=pharmacy,
         n=f"{pharmacy.int % 10**7:07d}")
    return str(pharmacy)


def _pre_registration(p: Practice) -> str:
    """A pending request in clinic A's queue, as the public form leaves it (details are opaque
    here: nothing below decrypts them)."""
    found = uuid.uuid4()
    _sql(p, "INSERT INTO admin.pre_registration (id, tenant_id, idempotency_key, "
         "request_hash, details, contact_consent) VALUES (:i, :t, :k, :h, CAST(:d AS jsonb), "
         "true)", i=found, t=p.clinic, k=uuid.uuid4(),
         h=hashlib.sha256(found.bytes).hexdigest(),
         d='{"name": "opaque", "birthDate": "opaque", "phones": "opaque"}')
    return str(found)


def _made(response: Any) -> tuple[str, str]:
    assert response.status_code == 201, response.text
    return response.json()["id"], response.headers.get("ETag", "")


def _rows(client: Any, p: Practice,  # noqa: F811
          users: dict[str, CurrentUser]) -> list[Row]:  # noqa: F811
    staff(p, users, "fd-a2", "fd", facility=p.other_facility)
    staff(p, users, "adm-b", "adm", clinic_b=True)
    # Marcus is seen only at A2; Kaia is the chart clinic B tries to reach.
    seen = _check_in(client, appointment_today(p, "marcus", facility=p.other_facility,
                                                provider=p.other_provider, hour=14),
                     user="fd-a2", selfPay=True)
    assert seen.status_code == 200, seen.text
    kaia, marcus, restricted = (str(p.patients[k]) for k in ("kaia", "marcus", "restricted"))
    pat = f"{API}/patients/{kaia}"
    patient_tag = client("fd").get(pat).headers["ETag"]
    identifier, _ = _made(client("fd").post(f"{pat}/identifiers", json={
        "type": "PI", "system": "urn:oid:2.16.840.1.113883.3.1", "value": "TEST-PI-SCOPE"}))
    relative, relative_tag = _made(client("fd").post(f"{pat}/related-persons", json=RELATIVE))
    coverage, coverage_tag = _made(client("fd").post(f"{pat}/coverages", json={
        "order": 1, "payerId": _payer(p), "memberId": "TEST-MEMBER-SCOPE",
        "relationshipToSubscriber": "self", "startDate": "2026-01-01"}))
    consent, _ = _made(client("fd").post(f"{pat}/consents", json=CONSENT))
    queued = _pre_registration(p)
    queue = f"{API}/pre-registrations"
    return [
        # --- A1's front desk and the patient seen only at A2: clinic-wide by design
        Row("searchPatients", "fd", "POST", f"{API}/patients/search", 200,
            json={"criteria": {"family": "Okafor904", "given": "Marcus"}}, shown=(marcus,),
            note=BY_DESIGN),
        Row("getPatient", "ma", "GET", f"{API}/patients/{marcus}", 200, shown=(marcus,),
            note=BY_DESIGN),
        Row("getPatientSummaries", "fd", "POST", f"{API}/patients/summaries", 200,
            json={"patientIds": [marcus]}, shown=(marcus,), note=BY_DESIGN),
        Row("listPatientIdentifiers", "fd", "GET", f"{API}/patients/{marcus}/identifiers", 200,
            note=BY_DESIGN),
        Row("listRelatedPersons", "fd", "GET", f"{API}/patients/{marcus}/related-persons", 200,
            note=BY_DESIGN),
        Row("listCoverages", "fd", "GET", f"{API}/patients/{marcus}/coverages", 200,
            note=BY_DESIGN),
        Row("listConsents", "fd", "GET", f"{API}/patients/{marcus}/consents", 200,
            note=BY_DESIGN),
        # --- clinic B: every ID of clinic A is 404, and nothing changes (RLS)
        Row("searchPatients", "fd-b", "POST", f"{API}/patients/search", 200,
            json={"criteria": {"family": "Lindgren118", "given": "Kaia"}}, hidden=(kaia,)),
        Row("getPatient", "fd-b", "GET", pat, 404),
        Row("updatePatient", "fd-b", "PATCH", pat, 404, json={"preferredName": "Kai"},
            headers={"If-Match": patient_tag, **MERGE}),
        Row("setPreferredPharmacy", "fd-b", "PUT", f"{pat}/preferred-pharmacy", 404,
            json={"pharmacyId": _pharmacy(p)}, headers={"If-Match": patient_tag}),
        Row("getPatientSummaries", "fd-b", "POST", f"{API}/patients/summaries", 200,
            json={"patientIds": [kaia, marcus]}, hidden=(kaia, marcus),
            note="another clinic's IDs are left out (D54)"),
        Row("restrictPatient", "adm-b", "POST", f"{pat}/restrict", 404,
            json={"category": "sensitive", "reason": "Test reason."}),
        Row("unrestrictPatient", "adm-b", "POST", f"{API}/patients/{restricted}/unrestrict",
            404, json={"reason": "Test reason."}),
        Row("listPatientIdentifiers", "fd-b", "GET", f"{pat}/identifiers", 404,
            hidden=(identifier,)),
        Row("addPatientIdentifier", "fd-b", "POST", f"{pat}/identifiers", 404, json={
            "type": "PI", "system": "urn:oid:2.16.840.1.113883.3.1", "value": "TEST-PI-B"}),
        Row("listRelatedPersons", "fd-b", "GET", f"{pat}/related-persons", 404),
        Row("addRelatedPerson", "fd-b", "POST", f"{pat}/related-persons", 404, json=RELATIVE),
        Row("updateRelatedPerson", "fd-b", "PATCH", f"{pat}/related-persons/{relative}", 404,
            json={"name": {"family": "Lindgren118", "given": ["Signe78"]}},
            headers={"If-Match": relative_tag, **MERGE}),
        Row("listCoverages", "fd-b", "GET", f"{pat}/coverages", 404),
        Row("addCoverage", "fd-b", "POST", f"{pat}/coverages", 404, json={
            "order": 2, "payerId": str(uuid.uuid4()), "memberId": "TEST-MEMBER-B",
            "relationshipToSubscriber": "self", "startDate": "2026-01-01"}),
        Row("getCoverage", "fd-b", "GET", f"{pat}/coverages/{coverage}", 404),
        Row("updateCoverage", "fd-b", "PATCH", f"{pat}/coverages/{coverage}", 404,
            json={"endDate": "2026-12-31"}, headers={"If-Match": coverage_tag, **MERGE}),
        Row("markCoverageEnteredInError", "fd-b", "POST",
            f"{pat}/coverages/{coverage}/entered-in-error", 404, json={"reason": "Wrong."}),
        Row("listConsents", "fd-b", "GET", f"{pat}/consents", 404, hidden=(consent,)),
        Row("recordConsent", "fd-b", "POST", f"{pat}/consents", 404, json=CONSENT),
        Row("listPreRegistrations", "fd-b", "GET", queue, 200, hidden=(queued,),
            note="the queue is the clinic's; it has no facility (D96)"),
        Row("getPreRegistration", "fd-b", "GET", f"{queue}/{queued}", 404),
        Row("acceptPreRegistration", "fd-b", "POST", f"{queue}/{queued}/accept", 404,
            json={"identityVerified": True, "idDocumentType": "drivers-license"}),
        Row("rejectPreRegistration", "fd-b", "POST", f"{queue}/{queued}/reject", 404,
            json={"reasonCode": "spam"}),
    ]


def test_every_patients_operation_follows_the_patient_and_clinic_rules(
        client: Any, practice: Practice,  # noqa: F811
        users: dict[str, CurrentUser]) -> None:  # noqa: F811
    outcomes = sweep(client, practice, _rows(client, practice, users))
    assert not failures(outcomes), report(failures(outcomes))
    covered = {o.row.operation for o in outcomes} | NO_RECORD_ID.keys()
    assert covered == served_operations("patients"), \
        "the table must cover every operation patients serves"
