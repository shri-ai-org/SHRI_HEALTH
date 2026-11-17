"""The patient portal's own lab results (listPortalLabResults) against a live database: the real
app, the portal as ``shri_portal``, the patient development sign-in (X-Dev-Patient, D108).
Reports are written as the staff side files them, as the database owner of the test clinic.
Synthetic data only."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import setup_session
from app.modules.scheduling.tests.portal_live import PortalChart, audit_rows, portal_client

from ..repository import V2_0074

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/portal/me/lab-results"
LOINC = "http://loinc.org"


def _sql(chart: PortalChart, sql: str, **params: Any) -> None:
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, chart.practice.clinic)
    try:
        db.execute(text(sql), params)
        db.commit()
    finally:
        db.close()
        admin.dispose()


def _report(chart: PortalChart, patient: uuid.UUID, when: str, *, category: str = "LAB",
            status: str = "final", code: str = "2160-0", short: str = "Creatinine",
            analytes: tuple[tuple[str, str, str, str | None], ...] = ()) -> str:
    """A report, registered first so its children can be written, then given its status."""
    rid = str(uuid.uuid4())
    _sql(chart, """
        INSERT INTO clinical.diagnostic_report (id, tenant_id, status, code_system, code_code,
               code_display, code_text, subject_patient_id, effective_date_time, issued,
               conclusion)
        VALUES (:id, :t, 'registered', :sys, :code, :code, :short, :p, CAST(:when AS timestamptz),
                CAST(:when AS timestamptz) + interval '4 hours', 'Reviewed.')""",
         id=rid, t=chart.practice.clinic, sys=LOINC, code=code, short=short, p=patient,
         when=when)
    _sql(chart, """INSERT INTO clinical.diagnostic_report_category (id, tenant_id,
               diagnostic_report_id, category_system, category_code)
               VALUES (:id, :t, :r, :sys, :cat)""",
         id=str(uuid.uuid4()), t=chart.practice.clinic, r=rid, sys=V2_0074, cat=category)
    for seq, (obs_code, value, unit, flag) in enumerate(analytes, start=1):
        oid = str(uuid.uuid4())
        _sql(chart, """
            INSERT INTO clinical.observation (id, tenant_id, status, code_system, code_code,
                   code_display, code_text, subject_patient_id, effective_date_time,
                   value_quantity_value, value_quantity_unit)
            VALUES (:id, :t, 'registered', :sys, :code, :code, :code, :p,
                    CAST(:when AS timestamptz),
                    CAST(:value AS numeric), :unit)""",
             id=oid, t=chart.practice.clinic, sys=LOINC, code=obs_code, p=patient, when=when,
             value=value, unit=unit)
        _sql(chart, """INSERT INTO clinical.observation_reference_range (id, tenant_id,
                   observation_id, low_value, high_value) VALUES (:id, :t, :o, 0.59, 1.04)""",
             id=str(uuid.uuid4()), t=chart.practice.clinic, o=oid)
        if flag:
            _sql(chart, """INSERT INTO clinical.observation_interpretation (id, tenant_id,
                       observation_id, interpretation_system, interpretation_code)
                       VALUES (:id, :t, :o,
                       'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', :f)""",
                 id=str(uuid.uuid4()), t=chart.practice.clinic, o=oid, f=flag)
        _sql(chart, """INSERT INTO clinical.diagnostic_report_result (id, tenant_id,
                   diagnostic_report_id, observation_id, sequence) VALUES (:id, :t, :r, :o, :s)""",
             id=str(uuid.uuid4()), t=chart.practice.clinic, r=rid, o=oid, s=seq)
        _sql(chart, "UPDATE clinical.observation SET status = 'final' WHERE id = :i", i=oid)
    _sql(chart, "UPDATE clinical.diagnostic_report SET status = :s WHERE id = :i",
         s=status, i=rid)
    return rid


def test_my_final_lab_results_newest_first_with_their_analytes(
        portal_app: Any, portal_chart: PortalChart) -> None:
    a = portal_chart.a
    old = _report(portal_chart, a, "2026-01-06T18:00:00Z",
                  analytes=(("2160-0", "0.79", "mg/dL", None),))
    new = _report(portal_chart, a, "2026-09-29T17:00:00Z",
                  analytes=(("2160-0", "1.40", "mg/dL", "HH"),))
    pending = _report(portal_chart, a, "2026-10-01T17:00:00Z", status="preliminary")
    wrong = _report(portal_chart, a, "2026-10-02T17:00:00Z", status="entered-in-error")
    imaging = _report(portal_chart, a, "2026-03-10T19:00:00Z", category="RAD",
                      code="30679-5", short="MR lumbar spine")
    me = portal_client(portal_app, portal_chart, a)
    found = me.get(API)
    assert found.status_code == 200, found.text
    items = found.json()["items"]
    assert [i["id"] for i in items] == [new, old]          # never preliminary, EIE or imaging
    assert not {pending, wrong, imaging} & {i["id"] for i in items}
    first = items[0]
    assert first["releaseStatus"] == "available" and first["status"] == "final"
    assert first["code"] == {"system": LOINC, "code": "2160-0", "display": "2160-0"}
    assert first["shortName"] == "Creatinine" and first["conclusion"] == "Reviewed."
    (analyte,) = first["results"]
    assert analyte["value"] == {"value": 1.4, "unit": "mg/dL"}
    assert analyte["referenceRange"] == {"low": 0.59, "high": 1.04}
    assert analyte["interpretation"] == "H"                # a critical high is shown as high
    assert "interpretation" not in items[1]["results"][0]
    rows = audit_rows(portal_chart.practice.clinic)
    assert any(r.patient_id == a and r.category == "phi-read" and r.actor_type == "patient"
               for r in rows)


def test_another_patients_results_do_not_exist(portal_app: Any,
                                               portal_chart: PortalChart) -> None:
    mine = _report(portal_chart, portal_chart.a, "2026-06-02T17:00:00Z")
    other = portal_client(portal_app, portal_chart, portal_chart.b)
    listed = other.get(API)
    assert listed.status_code == 200 and mine not in listed.text


def test_paging_bad_parameters_and_no_patient_session(portal_app: Any,
                                                      portal_chart: PortalChart) -> None:
    for day in ("2026-01-06", "2026-02-24", "2026-04-07"):
        _report(portal_chart, portal_chart.a, f"{day}T18:00:00Z")
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    page = me.get(API, params={"limit": 2}).json()
    assert len(page["items"]) == 2 and page["nextCursor"]
    rest = me.get(API, params={"limit": 2, "cursor": page["nextCursor"]}).json()
    assert len(rest["items"]) == 1 and "nextCursor" not in rest
    for params in ({"limit": 0}, {"limit": 101}):
        assert me.get(API, params=params).status_code == 422, params
    assert me.get(API, params={"cursor": "bm90LWFuLW9mZnNldA"}).status_code == 400
    refused = portal_app.get(API, headers={"X-Dev-User": "md"})  # a staff session isn't a patient's
    assert refused.status_code in (401, 403), refused.status_code
