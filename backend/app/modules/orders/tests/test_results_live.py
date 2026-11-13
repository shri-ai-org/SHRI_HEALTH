"""listLabResults and listImagingReports against a live database, as shri_app with core's
tenant_db, chart check and audit running for real. The reports are written as rows in the
FHIR-shaped tables, in the shape posted on #85 (13 Nov). Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _sql

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
V2_0074 = "http://terminology.hl7.org/CodeSystem/v2-0074"
LOINC = "http://loinc.org"


def _report(practice: Practice, patient: str, category: str, code: str, display: str,
            when: str, *, status: str = "final", conclusion: str | None = None,
            lab: str | None = None) -> str:
    rid = str(uuid.uuid4())
    _sql(practice, """
        INSERT INTO clinical.diagnostic_report (id, tenant_id, status, code_system, code_code,
               code_display, subject_patient_id, effective_date_time, issued, conclusion)
        VALUES (:id, :t, 'registered', :sys, :code, :display, :p, CAST(:when AS timestamptz),
                CAST(:when AS timestamptz) + interval '5 hours', :conclusion)""",
         id=rid, t=practice.clinic, sys=LOINC, code=code, display=display,
         p=patient, when=when, conclusion=conclusion)
    _sql(practice, """
        INSERT INTO clinical.diagnostic_report_category (id, tenant_id, diagnostic_report_id,
               category_system, category_code)
        VALUES (:id, :t, :r, :sys, :cat)""",
         id=str(uuid.uuid4()), t=practice.clinic, r=rid, sys=V2_0074, cat=category)
    if lab:
        org = str(uuid.uuid4())
        _sql(practice, "INSERT INTO clinical.organization (id, tenant_id, name) "
                       "VALUES (:id, :t, :name)", id=org, t=practice.clinic, name=lab)
        _sql(practice, """
            INSERT INTO clinical.diagnostic_report_performer (id, tenant_id,
                   diagnostic_report_id, organization_id) VALUES (:id, :t, :r, :o)""",
             id=str(uuid.uuid4()), t=practice.clinic, r=rid, o=org)
    STATUS[rid] = ("diagnostic_report", status)
    return rid


def _observation(practice: Practice, report: str, patient: str, sequence: int, code: str,
                 display: str, *, value: float | None = None, unit: str | None = None,
                 text: str | None = None, low: float | None = None, high: float | None = None,
                 flag: str | None = None, status: str = "final") -> str:
    oid = str(uuid.uuid4())
    _sql(practice, """
        INSERT INTO clinical.observation (id, tenant_id, status, code_system, code_code,
               code_display, subject_patient_id, value_quantity_value, value_quantity_unit,
               value_string, effective_date_time)
        VALUES (:id, :t, 'preliminary', :sys, :code, :display, :p, :v, :u, :s,
                (SELECT effective_date_time FROM clinical.diagnostic_report WHERE id = :r))""",
         r=report, id=oid, t=practice.clinic, sys=LOINC, code=code, display=display,
         p=patient, v=value, u=unit, s=text)
    _sql(practice, """
        INSERT INTO clinical.diagnostic_report_result (id, tenant_id, diagnostic_report_id,
               observation_id, sequence) VALUES (:id, :t, :r, :o, :n)""",
         id=str(uuid.uuid4()), t=practice.clinic, r=report, o=oid, n=sequence)
    if low is not None or high is not None:
        _sql(practice, """
            INSERT INTO clinical.observation_reference_range (id, tenant_id, observation_id,
                   low_value, low_unit, high_value, high_unit)
            VALUES (:id, :t, :o, :lo, :u, :hi, :u)""",
             id=str(uuid.uuid4()), t=practice.clinic, o=oid, lo=low, hi=high, u=unit)
    if flag:
        _sql(practice, """
            INSERT INTO clinical.observation_interpretation (id, tenant_id, observation_id,
                   interpretation_system, interpretation_code)
            VALUES (:id, :t, :o, :sys, :c)""",
             id=str(uuid.uuid4()), t=practice.clinic, o=oid,
             sys="http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", c=flag)
    _sql(practice, "UPDATE clinical.observation SET status = :s WHERE id = :i", s=status, i=oid)
    return oid


#: Each report's asked status, set once its children are in (a final report freezes them).
STATUS: dict[str, tuple[str, str]] = {}


def _finish(practice: Practice) -> None:
    for rid, (table, status) in list(STATUS.items()):
        _sql(practice, f"UPDATE clinical.{table} SET status = :s WHERE id = :i", s=status, i=rid)
        del STATUS[rid]


def _base(practice: Practice) -> tuple[str, str]:
    patient = str(practice.patients["kaia"])
    return patient, f"{API}/patients/{patient}"


def test_lab_results_newest_first_with_their_analytes(client: Any, practice: Practice,
                                                      users: dict[str, CurrentUser]) -> None:
    patient, base = _base(practice)
    older = _report(practice, patient, "LAB", "24331-1", "Lipid panel", "2026-06-16T17:00:00Z",
                    lab="Example Reference Laboratory (synthetic)")
    _observation(practice, older, patient, 1, "2093-3", "Cholesterol", value=212, unit="mg/dL",
                 low=0, high=199, flag="H")
    newer = _report(practice, patient, "LAB", "4548-4", "Hemoglobin A1c", "2026-10-27T16:10:00Z")
    _observation(practice, newer, patient, 2, "4548-4", "HbA1c", value=7.2, unit="%",
                 low=4, high=5.6, flag="H")
    _observation(practice, newer, patient, 1, "2345-7", "Glucose", value=148, unit="mg/dL")
    _observation(practice, newer, patient, 3, "2160-0", "Creatinine", value=0.9, unit="mg/dL",
                 status="entered-in-error")
    for hidden in ("entered-in-error", "preliminary", "cancelled", "registered"):
        _report(practice, patient, "LAB", "58410-2", "CBC", "2026-11-01T16:00:00Z",
                status=hidden)
    _report(practice, patient, "RAD", "36643-5", "XR Chest 2 Views", "2026-11-02T16:00:00Z")

    _finish(practice)
    found = client("md").get(f"{base}/lab-results")
    assert found.status_code == 200, found.text
    items = found.json()["items"]
    assert [i["id"] for i in items] == [newer, older]  # newest first; RAD and e-i-e left out
    # A read of the chart is audited as a chart access naming the patient.
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p "
                "AND category = 'phi-read'", p=patient)[0][0] >= 1
    assert items[0]["code"]["codings"][0] == {"system": LOINC, "code": "4548-4",
                                              "display": "Hemoglobin A1c"}
    assert items[0]["status"] == "final" and items[0]["collectedAt"].startswith("2026-10-27")
    assert [o["code"]["codings"][0]["code"] for o in items[0]["observations"]] == [
        "2345-7", "4548-4"]                              # the lab's order; e-i-e analyte out
    a1c = items[0]["observations"][1]
    assert a1c["value"] == {"value": 7.2, "unit": "%"} and a1c["interpretation"] == "H"
    assert a1c["referenceRange"] == {"low": {"value": 4.0, "unit": "%"},
                                     "high": {"value": 5.6, "unit": "%"}}
    assert items[1]["performer"] == "Example Reference Laboratory (synthetic)"
    page = client("md").get(f"{base}/lab-results", params={"limit": 1})
    assert [i["id"] for i in page.json()["items"]] == [newer] and page.json()["nextCursor"]
    rest = client("md").get(f"{base}/lab-results",
                            params={"limit": 1, "cursor": page.json()["nextCursor"]})
    assert [i["id"] for i in rest.json()["items"]] == [older]
    assert "nextCursor" not in rest.json()


def test_imaging_reports_are_text_only(client: Any, practice: Practice,
                                       users: dict[str, CurrentUser]) -> None:
    patient, base = _base(practice)
    report = _report(practice, patient, "RAD", "36643-5", "XR Chest 2 Views",
                     "2026-09-15T17:20:00Z", conclusion="No acute cardiopulmonary abnormality.",
                     lab="Example Radiology Group (synthetic)")
    _observation(practice, report, patient, 1, "18782-3", "Radiology study observation",
                 text="Technique: PA and lateral views. Findings: The lungs are clear.")
    _report(practice, patient, "LAB", "4548-4", "Hemoglobin A1c", "2026-10-27T16:10:00Z")
    _finish(practice)
    found = client("md").get(f"{base}/imaging-reports")
    assert found.status_code == 200, found.text
    (only,) = found.json()["items"]
    assert only["id"] == report and only["impression"] == "No acute cardiopulmonary abnormality."
    assert only["text"] == ("Technique: PA and lateral views. Findings: The lungs are clear.\n\n"
                            "Impression: No acute cardiopulmonary abnormality.")
    assert only["performer"] == "Example Radiology Group (synthetic)"
    assert only["studiedAt"].startswith("2026-09-15") and "observations" not in only


def test_reads_need_results_read_and_a_known_patient(client: Any, practice: Practice,
                                                     users: dict[str, CurrentUser]) -> None:
    _, base = _base(practice)
    for path in ("lab-results", "imaging-reports"):
        assert client("ma").get(f"{base}/{path}").status_code == 200, path
        refused = client("fd").get(f"{base}/{path}")
        assert refused.status_code == 403 and refused.json()["code"] == "permission-denied", path
        missing = client("md").get(f"{API}/patients/{uuid.uuid4()}/{path}")
        assert missing.status_code == 404, path


def test_a_restricted_chart_needs_break_glass(client: Any, practice: Practice,
                                              users: dict[str, CurrentUser]) -> None:
    patient, base = _base(practice)
    _report(practice, patient, "LAB", "4548-4", "Hemoglobin A1c", "2026-10-27T16:10:00Z")
    _finish(practice)
    _sql(practice, "UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i",
         i=patient)
    def denials() -> int:
        return int(_sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p "
                    "AND action = 'access-denied' AND outcome = 'denied'", p=patient)[0][0])

    for path in ("lab-results", "imaging-reports"):
        before = denials()
        refused = client("md").get(f"{base}/{path}")
        assert refused.status_code == 403, path
        assert refused.json()["code"] == "break-glass-required", path
        assert denials() == before + 1, path          # core's ensure_chart_access audits it
    # A care-team member opens the restricted chart without break-glass (D37).
    _sql(practice, "INSERT INTO admin.care_team_member (id, tenant_id, patient_id, user_id, "
         "role_code, period_start) VALUES (:i, :t, :p, :u, 'care-manager', :s)",
         i=uuid.uuid4(), t=practice.clinic, p=patient, u=users["ma"].id,
         s=dt.date.today() - dt.timedelta(days=30))
    for path in ("lab-results", "imaging-reports"):
        opened = client("ma").get(f"{base}/{path}")
        assert opened.status_code == 200, (path, opened.text)
    assert [i["code"]["codings"][0]["code"]
            for i in client("ma").get(f"{base}/lab-results").json()["items"]] == ["4548-4"]


def test_bad_paging_parameters_are_refused(client: Any, practice: Practice,
                                           users: dict[str, CurrentUser]) -> None:
    _, base = _base(practice)
    for path in ("lab-results", "imaging-reports"):
        for params in ({"limit": 0}, {"limit": 101}):
            refused = client("md").get(f"{base}/{path}", params=params)
            assert refused.status_code == 422, (path, params)
            assert refused.json()["code"] == "validation-failed", (path, params)
        bad = client("md").get(f"{base}/{path}", params={"cursor": "bm90LWFuLW9mZnNldA"})
        assert bad.status_code == 400 and bad.json()["code"] == "invalid-cursor", path


def test_another_clinics_patient_is_not_found(client: Any, practice: Practice,
                                              users: dict[str, CurrentUser]) -> None:
    patient, base = _base(practice)
    _report(practice, patient, "LAB", "4548-4", "Hemoglobin A1c", "2026-10-27T16:10:00Z")
    _finish(practice)
    for path in ("lab-results", "imaging-reports"):
        assert client("md-b").get(f"{base}/{path}").status_code == 404, path
