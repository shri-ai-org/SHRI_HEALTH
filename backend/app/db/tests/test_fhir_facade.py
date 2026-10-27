"""The FHIR facade emits valid FHIR: every resource built here is serialized from the tables and
parsed by an independent FHIR model library (fhir.resources, R4B), then served through the
FastAPI endpoints with read / vread / history / search, audit and break-the-glass."""
from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from fhir.resources.R4B import get_fhir_model_class
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.db.models import FHIR_RESOURCES, MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, TEST_DATABASE_URL, switch_to_role
from app.fhir.serializer import SnapshotRow, to_fhir

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS


def validate(resource: dict[str, Any]) -> None:
    get_fhir_model_class(resource["resourceType"]).model_validate(resource)


@pytest.fixture
def chart(db: Session) -> dict[str, Any]:
    """One chart touching every FHIR resource table."""
    t = db.info["tenant_id"]
    ctx = b.practice(db)
    pt = b.patient(db)
    rp = M["related_person"](patient_id=pt.id, gender="male")
    rp.name = [M["human_name"](family="Nguyen", given=["Bao"])]
    rp.relationship = [M["related_person_relationship"](code_system=systems.V3_ROLE_CODE,
                                                        code_code="SPS", code_display="spouse")]
    role = M["practitioner_role"](practitioner_id=ctx["practitioner"].id,
                                  organization_id=ctx["org"].id,
                                  code_system=systems.NUCC, code_code="2084N0400X")
    role.specialty = [M["practitioner_role_specialty"](specialty_system=systems.NUCC,
                                                       specialty_code="2084N0400X",
                                                       specialty_display="Neurology")]
    role.location = [M["practitioner_role_location"](location_id=ctx["site"].id)]
    sched = M["schedule"](comment="Dr Rivera clinic")
    sched.actor = [M["schedule_actor"](practitioner_id=ctx["practitioner"].id)]
    db.add_all([rp, role, sched])
    db.flush()
    appt = M["appointment"](status="booked", subject_patient_id=pt.id, start=b.NOW,
                            end=b.NOW + dt.timedelta(minutes=30), minutes_duration=30,
                            description="Migraine follow-up")
    appt.participant = [M["appointment_participant"](actor_practitioner_id=ctx["practitioner"].id),
                        M["appointment_participant"](actor_patient_id=pt.id)]
    appt.reason = [M["appointment_reason"](reason_code_system=systems.SNOMED,
                                           reason_code_code="37796009",
                                           reason_code_display="Migraine")]
    db.add(appt)
    db.flush()
    enc = b.encounter(db, pt, ctx)
    enc.appointment_id = appt.id
    enc.type = [M["encounter_type"](type_system=systems.CPT, type_code="99214")]
    enc.location = [M["encounter_location"](location_id=ctx["room"].id, status="active")]
    cond = b.condition(db, pt, enc)
    db.add(M["encounter_diagnosis"](encounter_id=enc.id, condition_id=cond.id, rank=1,
                                    use_system=systems.DIAGNOSIS_ROLE, use_code="billing"))
    db.add(M["condition_coding"](condition_id=cond.id, system=systems.SNOMED, code="37796009",
                                 display="Migraine"))
    allergy = M["allergy_intolerance"](clinical_status="active", verification_status="confirmed",
                                       category=["medication"], criticality="high",
                                       code_system=systems.RXNORM, code_code="7980",
                                       code_display="Penicillin G", patient_id=pt.id)
    allergy.reaction = [M["allergy_intolerance_reaction"](severity="moderate")]
    db.add(allergy)
    db.flush()
    db.add(M["allergy_reaction_manifestation"](reaction_id=allergy.reaction[0].id,
                                               manifestation_system=systems.SNOMED,
                                               manifestation_code="247472004",
                                               manifestation_display="Hives"))
    bp = b.blood_pressure(db, pt, enc)
    smoking = M["observation"](status="final", code_system=systems.LOINC, code_code="72166-2",
                               subject_patient_id=pt.id, effective_date_time=b.NOW,
                               value_codeable_concept_system=systems.SNOMED,
                               value_codeable_concept_code="266919005",
                               value_codeable_concept_display="Never smoker")
    smoking.category = [M["observation_category"](category_system=systems.OBSERVATION_CATEGORY,
                                                  category_code="social-history")]
    proc = M["procedure"](status="completed", code_system=systems.SNOMED, code_code="80146002",
                          code_display="Appendectomy", subject_patient_id=pt.id,
                          performed_string="2009")
    fmh = M["family_member_history"](status="completed", patient_id=pt.id,
                                     relationship_system=systems.V3_ROLE_CODE,
                                     relationship_code="MTH", relationship_display="mother")
    fmh.condition = [M["family_member_history_condition"](code_system=systems.SNOMED,
                                                          code_code="37796009",
                                                          code_display="Migraine")]
    imm = M["immunization"](status="completed", vaccine_code_system=systems.CVX,
                            vaccine_code_code="140", patient_id=pt.id,
                            occurrence_date_time=b.NOW - dt.timedelta(days=30),
                                primary_source=False)
    med = M["medication"](code_system=systems.RXNORM, code_code="1049630")
    db.add_all([smoking, proc, fmh, imm, med])
    db.flush()
    mr = b.prescription(db, pt, enc, ctx)
    stmt = M["medication_statement"](status="active", subject_patient_id=pt.id,
                                     medication_codeable_concept_system=systems.RXNORM,
                                     medication_codeable_concept_code="1049630",
                                     based_on_medication_request_id=mr.id)
    disp = M["medication_dispense"](status="completed", subject_patient_id=pt.id,
                                    medication_medication_id=med.id,
                                    authorizing_prescription_id=mr.id, quantity_value=9,
                                    when_handed_over=b.NOW)
    issue = M["detected_issue"](status="final", severity="low", patient_id=pt.id,
                                code_system=systems.V3_ACT_CODE, code_code="DUPTHPY",
                                ext_rule_source="deterministic",
                                ext_cds_rule_id=None)
    db.add_all([stmt, disp])
    rule = M["cds_rule"](tenant_id=t, code="dup", name="Duplicate therapy",
                         alert_type="duplicate", default_severity="low")
    db.add(rule)
    db.flush()
    issue.ext_cds_rule_id = rule.id
    issue.implicated = [M["detected_issue_implicated"](medication_request_id=mr.id)]
    db.add(issue)
    sr = M["service_request"](status="draft", intent="order", subject_patient_id=pt.id,
                              encounter_id=enc.id, code_system=systems.LOINC,
                              code_code="24323-8", code_display="CMP",
                              requester_practitioner_id=ctx["practitioner"].id,
                              requisition_system="urn:shri:req", requisition_value="REQ-1")
    sr.category = [M["service_request_category"](category_system=systems.SNOMED,
                                                 category_code="108252007")]
    sr.reason = [M["service_request_reason"](rank=1, condition_id=cond.id)]
    spec = M["specimen"](subject_patient_id=pt.id, status="available",
                         collection_collected_date_time=b.NOW, ext_label_barcode="BC-1")
    db.add_all([sr, spec])
    db.flush()
    dr = M["diagnostic_report"](status="final", code_system=systems.LOINC, code_code="24323-8",
                                subject_patient_id=pt.id, encounter_id=enc.id,
                                effective_date_time=b.NOW, issued=b.NOW)
    dr.based_on = [M["diagnostic_report_based_on"](service_request_id=sr.id)]
    dr.result = [M["diagnostic_report_result"](observation_id=bp.id)]
    dr.category = [M["diagnostic_report_category"](category_system=systems.V2_0074,
                                                   category_code="LAB")]
    blob = M["binary_object"](bucket="docs", storage_key=f"k/{uuid.uuid4()}.pdf",
                              content_type="application/pdf",
                              size_bytes=10, sha256="a" * 64)
    db.add_all([dr, blob])
    db.flush()
    doc = M["document_reference"](status="current", type_system=systems.LOINC,
                                  type_code="34133-9", subject_patient_id=pt.id, date=b.NOW,
                                  ext_origin="ccda")
    doc.content = [M["document_reference_content"](attachment_content_type="application/pdf",
                                                   attachment_binary_object_id=blob.id)]
    doc.category = [M["document_reference_category"](category_system=systems.DOC_CLASS,
                                                     category_code="clinical-note")]
    consent = M["consent"](status="active", scope_system=systems.CONSENT_SCOPE,
                           scope_code="treatment", patient_id=pt.id, date_time=b.NOW,
                           ext_kind="treatment", ext_signature_method="electronic")
    consent.category = [M["consent_category"](category_system=systems.LOINC,
                                              category_code="59284-0")]
    cov = M["coverage"](status="active", beneficiary_patient_id=pt.id, order=1,
                        relationship_code="self", subscriber_id="W123456789")
    db.add_all([doc, consent, cov])
    db.flush()
    cov.class_ = [M["coverage_class"](type="group", value="GRP-55", name="Acme Inc")]
    cov.cost_to_beneficiary = [M["coverage_cost_to_beneficiary"](
        type_system=systems.COVERAGE_COPAY_TYPE, type_code="copay", value_money_value=25)]
    cov.payor = [M["coverage_payor"](patient_id=pt.id)]
    note = b.note(db, pt, enc, ctx)
    b.sign_note(db, note, ctx)
    prov = M["provenance"](target_resource_type="Composition", target_id=note.id,
                           recorded=b.NOW, activity_system=systems.V3_DATA_OPERATION,
                           activity_code="CREATE")
    prov.agent = [M["provenance_agent"](who_practitioner_id=ctx["practitioner"].id)]
    db.add(prov)
    db.commit()
    return {"patient": pt, "ctx": ctx, "encounter": enc, "observation": bp, "note": note}


def test_every_resource_type_serializes_to_valid_fhir(db: Session, chart: dict[str, Any]) -> None:
    seen, errors = set(), []
    for rtype, cls in sorted(FHIR_RESOURCES.items()):
        for obj in db.query(cls).all():
            try:
                validate(to_fhir(obj))
            except Exception as exc:     # collect every problem, not just the first
                errors.append(f"{rtype}: {exc}")
            seen.add(rtype)
    assert not errors, "\n".join(errors)
    assert seen == set(FHIR_RESOURCES), set(FHIR_RESOURCES) - seen


def test_patient_shape(db: Session, chart: dict[str, Any]) -> None:
    r = to_fhir(chart["patient"])
    assert r["name"][0] == {"use": "official", "family": "Nguyen", "given": ["Mai"]}
    assert r["identifier"][0]["type"]["coding"][0]["code"] == "MR"
    assert r["telecom"][0]["system"] == "phone"
    urls = {e["url"] for e in r["extension"]}
    assert "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race" in urls
    assert "http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex" in urls
    assert r["meta"]["tag"][0]["code"] == "clinician"
    assert r["communication"][0]["language"]["coding"][0]["code"] == "en-US"


def test_observation_components_and_condition_codings(db: Session, chart: dict[str, Any]) -> None:
    bp = to_fhir(chart["observation"])
    assert [c["valueQuantity"]["value"] for c in bp["component"]] == [128, 82]
    assert bp["category"][0]["coding"][0]["code"] == "vital-signs"
    cond = to_fhir(db.query(M["condition"]).one())
    codes = {c["system"]: c["code"] for c in cond["code"]["coding"]}
    assert codes == {systems.ICD10CM: "G43.909", systems.SNOMED: "37796009"}
    assert cond["clinicalStatus"]["coding"][0]["system"] == systems.CONDITION_CLINICAL


def test_history_snapshot_serializes_like_the_live_row(db: Session, chart: dict[str, Any]) -> None:
    pt = chart["patient"]
    snap = db.execute(text("SELECT snapshot FROM clinical.fhir_resource_history "
                           "WHERE resource_id = :i "
                           "AND version_id = :v"),
                      {"i": pt.id, "v": pt.meta_version_id}).scalar_one()
    live, hist = to_fhir(pt), to_fhir(M["patient"], SnapshotRow(snap))
    assert hist == live


# --------------------------------------------------------------------------- HTTP
@pytest.fixture
def client(chart: dict[str, Any], db: Session) -> Iterator[TestClient]:
    """The facade as ``shri_app``. Kept for the restricted-chart test, which still checks
    break-glass (``audit.break_glass_access``, which ``shri_fhir_reader`` cannot read) until
    the restricted-chart design replaces ``ensure_chart_access``."""
    yield from _facade_client(chart, db, "shri_app")


@pytest.fixture
def reader_client(chart: dict[str, Any], db: Session) -> Iterator[TestClient]:
    """The facade as ``shri_fhir_reader``, the role /fhir runs as (D22, D23)."""
    yield from _facade_client(chart, db, "shri_fhir_reader")


def _facade_client(chart: dict[str, Any], db: Session, role: str) -> Iterator[TestClient]:
    """A local app mounting only the FHIR facade router, with both of its seams overridden:
    ``machine_token_auth`` with a fixed AuthContext, and ``fhir_db`` with a session from the
    core's own ``Database.tenant_session`` (the same per-transaction clinic settings
    ``tenant_db`` uses), connected as ``role``."""
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from sqlalchemy.exc import DBAPIError

    from app.core.config import Settings
    from app.core.db import Database
    from app.fhir.api import AuthContext, fhir_db, machine_token_auth, outcome_from_db_error, router

    app = FastAPI()
    app.include_router(router)

    @app.exception_handler(DBAPIError)
    async def _db_error(request: Any, exc: DBAPIError) -> JSONResponse:
        http_exc = outcome_from_db_error(exc)
        return JSONResponse(http_exc.detail, status_code=http_exc.status_code)

    database = Database(Settings(database_url=TEST_DATABASE_URL))
    switch_to_role(database.engine.sync_engine, role,
                   require_search_path=role != "shri_fhir_reader")
    ctx = AuthContext(db.info["tenant_id"], chart["ctx"]["user"].id, frozenset({"clinician"}))

    async def _fhir_db() -> AsyncIterator[AsyncSession]:
        session = database.tenant_session(ctx.tenant_id, ctx.user_id, ctx.correlation_id)
        async with session:
            yield session

    app.dependency_overrides[machine_token_auth] = lambda: ctx
    app.dependency_overrides[fhir_db] = _fhir_db
    with TestClient(app) as c:
        yield c
        assert c.portal is not None  # set while the client is open
        c.portal.call(database.dispose)  # on the loop that owns the connections
    app.dependency_overrides.clear()


def test_http_read_as_fhir_reader_is_audited(reader_client: TestClient,
                                             chart: dict[str, Any],
                                             admin_engine: Engine) -> None:
    """As shri_fhir_reader, which may insert audit rows but not read them: the audit insert
    must work without RETURNING, and the read must still succeed."""
    pt = chart["patient"]
    r = reader_client.get(f"/fhir/r4/Patient/{pt.id}")
    assert r.status_code == 200
    validate(r.json())
    found = reader_client.post("/fhir/r4/Observation/_search",
                               json={"patient": f"Patient/{pt.id}",
                                     "code": f"{systems.LOINC}|85354-9"}).json()
    assert found["total"] == 1
    with admin_engine.connect() as c:
        audited = c.execute(text("SELECT count(*) FROM audit.audit_event WHERE patient_id = :p "
                                 "AND action = 'read'"), {"p": pt.id}).scalar_one()
    assert audited == 2


def test_http_read_vread_history_search(client: TestClient,
                                        chart: dict[str, Any],
                                        db: Session,
                                        admin_engine: Engine) -> None:
    pt = chart["patient"]
    r = client.get(f"/fhir/r4/Patient/{pt.id}")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/fhir+json")
    validate(r.json())
    assert r.headers["etag"] == f'W/"{pt.meta_version_id}"'

    pt.name[0].family = "Tran"
    db.commit()
    db.refresh(pt)
    v_now = pt.meta_version_id
    assert client.get(f"/fhir/r4/Patient/{pt.id}").json()["name"][0]["family"] == "Tran"
    old = client.get(f"/fhir/r4/Patient/{pt.id}/_history/{v_now - 1}").json()
    assert old["name"][0]["family"] == "Nguyen" and old["meta"]["versionId"] == str(v_now - 1)
    bundle = client.get(f"/fhir/r4/Patient/{pt.id}/_history").json()
    validate(bundle)
    assert bundle["total"] == v_now

    found = client.post("/fhir/r4/Patient/_search", json={"family": "tra"}).json()
    assert [e["resource"]["id"] for e in found["entry"]] == [str(pt.id)]
    obs = client.post("/fhir/r4/Observation/_search",
                      json={"patient": f"Patient/{pt.id}",
                            "code": f"{systems.LOINC}|85354-9"}).json()
    validate(obs)
    assert obs["total"] == 1
    # Audit rows are checked as the superuser, the same as every other audit-review access in
    # this test file, so the check does not depend on the role under test.
    with admin_engine.connect() as c:
        audited = c.execute(text("SELECT count(*) FROM audit.audit_event WHERE patient_id = :p "
                                 "AND action = 'read'"), {"p": pt.id}).scalar_one()
    assert audited >= 4


def test_http_restricted_chart_needs_break_glass(client: TestClient,
                                                 chart: dict[str, Any],
                                                 db: Session,
                                                 admin_engine: Engine) -> None:
    pt = chart["patient"]
    pt.meta_security = ["R"]
    db.commit()
    r = client.get(f"/fhir/r4/Observation/{chart['observation'].id}")
    assert r.status_code == 403
    assert client.post("/fhir/r4/Patient/_search", json={"family": "Ngu"}).json()["total"] == 0
    db.add(M["break_glass_access"](patient_id=pt.id, user_id=chart["ctx"]["user"].id,
                                   reason_code="continuity-of-care",
                                   granted_at=dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1),
                                   expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(hours=1)))
    db.commit()
    assert client.get(f"/fhir/r4/Observation/{chart['observation'].id}").status_code == 200
    with admin_engine.connect() as c:
        denied = c.execute(text("SELECT count(*) FROM audit.audit_event WHERE patient_id = :p "
                                "AND action = 'access-denied'"), {"p": pt.id}).scalar()
    assert denied == 1


def test_http_capability_statement(client: TestClient) -> None:
    # api/admin.py (generated CRUD) isn't adopted - admin endpoints come from each module
    # owner's own code against contracts/openapi/ instead (D20/ADR-0011 condition 1), so the
    # constraint-error-mapping half of this test (previously exercised via admin CRUD) doesn't
    # have a replacement here; db_error_detail's mapping itself has no test of its own yet.
    assert client.get("/fhir/r4/metadata").json()["fhirVersion"] == "4.0.1"


def test_unknown_resource_type_is_404(client: TestClient) -> None:
    assert client.get(f"/fhir/r4/Basic/{uuid.uuid4()}").status_code == 404
