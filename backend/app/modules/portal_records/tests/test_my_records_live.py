"""The patient's "My records" PDF (getPortalRecordDownloadUrl, then downloadPortalFileContent)
against a live database: the real app, the portal as ``shri_portal``, the patient development
sign-in (X-Dev-Patient, D108), core's portal download tokens (#409), real AES-256-GCM over test
data keys and an in-memory store. The PDF holds the patient's released items only, never a held,
draft, entered-in-error, PSY-labelled or preliminary one, nor another patient's (D86, D90).
Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core import download_tokens as core_tokens
from app.core.download_tokens import PortalDownloadTokens
from app.db.models import MAPPERS, systems
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.documents.after_visit_summary import format_visit_date
from app.modules.files import crypto as files_crypto
from app.modules.files import storage
from app.modules.files.tests.fakes import TOKEN_SECRET, FakeFileCrypto, MemoryFileStore
from app.modules.scheduling.tests.conftest import setup_session
from app.modules.scheduling.tests.portal_live import (
    PortalChart,
    _appointment,
    _summary,
    _visit,
    portal_client,
)

from .. import records_pdf, records_service
from .test_portal_lab_results_live import _report, _sql

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = MAPPERS
API = "/api/v1/portal/me/record-download-url"


@pytest.fixture
def files(portal_app: TestClient) -> Iterator[dict[str, Any]]:
    """The app's file store, crypto and portal tokens, swapped for test ones."""
    world = {"store": MemoryFileStore(), "crypto": FakeFileCrypto(),
             "tokens": PortalDownloadTokens(TOKEN_SECRET)}
    overrides = portal_app.app.dependency_overrides  # type: ignore[attr-defined]
    overrides[storage.file_store] = lambda: world["store"]
    overrides[files_crypto.file_crypto] = lambda: world["crypto"]
    overrides[core_tokens.portal_download_tokens] = lambda: world["tokens"]
    yield world
    overrides.clear()


def _admin_rows(sql: str, **params: Any) -> list[Any]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            return list(c.execute(text(sql), params))
    finally:
        admin.dispose()


def _visit_day(document: uuid.UUID) -> str:
    """How the PDF writes the date of the visit an after-visit summary belongs to."""
    (row,) = _admin_rows("""
        SELECT e.period_start, f.timezone FROM clinical.document_reference d
        JOIN clinical.encounter e ON e.id = d.context_encounter_id
        JOIN admin.facility f ON f.id = e.ext_facility_id WHERE d.id = :d""", d=document)
    return f"Visit of {format_visit_date(row.period_start, row.timezone)}"


def _chart_items(chart: PortalChart) -> dict[str, Any]:
    """Patient A's records, each named so the PDF can be searched for it, and patient B's."""
    a, b, p = chart.a, chart.b, chart.practice
    now = dt.datetime.now(dt.UTC).replace(microsecond=0)
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, p.clinic)
    out: dict[str, Any] = {}
    try:
        clinician = db.execute(text("SELECT held_by_user_id FROM admin.release_hold "
                                    "WHERE tenant_id = :t LIMIT 1"), {"t": p.clinic}
                               ).scalar_one()

        def problem(patient: uuid.UUID, name: str, **kw: Any) -> Any:
            verification = kw.pop("verification", "confirmed")
            c = M["condition"](clinical_status=None if verification == "entered-in-error"
                               else "active", verification_status=verification,
                               code_system=systems.ICD10CM, code_code="G43.909",
                               code_display=name, subject_patient_id=patient,
                               recorded_date=now - dt.timedelta(days=30))
            c.category = [M["condition_category"](category_system=systems.CONDITION_CATEGORY,
                                                  category_code="problem-list-item")]
            db.add(c)
            db.flush()
            return c

        def allergy(patient: uuid.UUID, name: str) -> None:
            db.add(M["allergy_intolerance"](patient_id=patient, clinical_status="active",
                                            verification_status="confirmed", code_text=name,
                                            recorded_date=now - dt.timedelta(days=60)))

        def medication(patient: uuid.UUID, name: str, status: str, intent: str) -> None:
            db.add(M["medication_request"](
                status=status, intent=intent, subject_patient_id=patient,
                reported_boolean=intent == "plan", requester_patient_id=patient,
                medication_codeable_concept_text=name, authored_on=now))

        problem(a, "Synthmigraine401")
        held = problem(a, "Synthheldproblem401")
        problem(a, "Synthwrongproblem401", verification="entered-in-error")
        problem(b, "Synthotherproblem904")
        allergy(a, "Synthpeanut401")
        allergy(b, "Synthotherallergy904")
        medication(a, "Synthmedactive401", "active", "plan")
        medication(a, "Synthmeddraft401", "draft", "plan")
        medication(b, "Synthmedother904", "active", "plan")
        db.add(M["release_hold"](tenant_id=p.clinic, patient_id=a, condition_id=held.id,
                                 reason="patient-request", held_by_user_id=clinician))
        # A psychotherapy-labelled visit summary: never listed, not even by its visit's date.
        visit = _appointment(db, p, a, now - dt.timedelta(days=50), "fulfilled")
        psy = _summary(db, a, _visit(db, p, a, visit), visit.end + dt.timedelta(hours=1))
        psy.meta_security = ["PSY"]
        db.flush()
        out["psy-avs"] = psy.id
        db.commit()
    finally:
        db.close()
        admin.dispose()
    _report(chart, a, "2026-09-29T17:00:00Z", short="Synthlabfinal",
            analytes=(("2160-0", "1.40", "mg/dL", "H"),))
    _report(chart, a, "2026-09-30T17:00:00Z", short="Synthlabprelim", status="preliminary")
    held_lab = _report(chart, a, "2026-10-01T17:00:00Z", short="Synthlabheld")
    _report(chart, a, "2026-03-10T19:00:00Z", category="RAD", code="30679-5",
            short="Synthimaging401")
    _report(chart, b, "2026-09-29T17:00:00Z", short="Synthlabother904")
    _sql(chart, """INSERT INTO admin.release_hold (id, tenant_id, patient_id,
                   diagnostic_report_id, reason, held_by_user_id)
                   SELECT :i, :t, :p, :r, 'risk-of-harm', held_by_user_id
                   FROM admin.release_hold WHERE tenant_id = :t LIMIT 1""",
         i=uuid.uuid4(), t=chart.practice.clinic, p=a, r=held_lab)
    return out


def _download(me: Any, link: dict[str, Any]) -> Any:
    return me.get(link["url"])


def _ask(me: Any, fmt: str | None = "pdf") -> Any:
    return me.get(API, params={"format": fmt} if fmt else None)


def _export_rows(clinic: uuid.UUID) -> list[Any]:
    return _admin_rows("SELECT e.*, b.purpose, b.state, b.content_type, b.retention_until "
                       "FROM admin.portal_record_export e JOIN admin.binary_object b "
                       "ON b.id = e.binary_object_id WHERE e.tenant_id = :t", t=clinic)


def test_my_record_downloads_once_with_only_my_released_items_and_is_audited(
        portal_app: Any, portal_chart: PortalChart, files: dict[str, Any]) -> None:
    extra = _chart_items(portal_chart)
    a, ids = portal_chart.a, portal_chart.ids
    me = portal_client(portal_app, portal_chart, a)
    asked = _ask(me)
    assert asked.status_code == 200, asked.text
    link = asked.json()
    assert set(link) == {"url", "expiresAt"}
    file_id = uuid.UUID(urlsplit(link["url"]).path.split("/")[-2])
    assert link["url"].startswith(f"/api/v1/portal/me/files/{file_id}/content?token=")
    (row,) = _export_rows(portal_chart.practice.clinic)
    assert (row.patient_id, row.binary_object_id, row.format, row.purpose, row.state,
            row.content_type) == (a, file_id, "pdf", "export", "clean", "application/pdf")
    assert row.expires_at - row.created_at == dt.timedelta(minutes=15)
    assert row.retention_until == row.expires_at + dt.timedelta(hours=24)
    stored, _ = next(iter(files["store"].objects.values()))
    assert b"Synthpeanut401" not in stored and not stored.startswith(b"%PDF")  # sealed

    got = _download(me, link)
    assert got.status_code == 200, got.text
    assert got.headers["content-type"] == "application/pdf"
    assert got.headers["content-disposition"] == f'attachment; filename="export-{file_id}.pdf"'
    pdf = got.content.decode("latin-1")
    assert pdf.startswith("%PDF-1.4")
    for shown in ("Health record summary", "Patient: Kaia401 Lindgren118", "Synthpeanut401",
                  "Synthmigraine401", "Synthmedactive401", "Synthlabfinal",
                  "1.4 mg/dL H \\(range 0.59 to 1.04\\)", "Synthimaging401",
                  "Impression: Reviewed.", "Visits",
                  _visit_day(ids["a-avs"]), records_pdf.CLOSING):
        assert shown in pdf, shown
    for hidden in ("Synthheldproblem401", "Synthwrongproblem401", "Synthmeddraft401",
                   "Synthlabprelim", "Synthlabheld", "Synthotherproblem904",
                   "Synthotherallergy904", "Synthmedother904", "Synthlabother904",
                   "Okafor904", "Marcus217", _visit_day(ids["a-draft-avs"]),
                   _visit_day(ids["a-wrong-avs"]), _visit_day(ids["a-held-avs"]),
                   _visit_day(extra["psy-avs"])):
        assert hidden not in pdf, hidden
    assert _download(me, link).status_code == 404                  # a token is used once

    token = parse_qs(urlsplit(link["url"]).query)["token"][0]
    audited = _admin_rows(
        "SELECT action, category, actor_type, patient_id, entity_type, entity_id, reason "
        "FROM audit.audit_event WHERE tenant_id = :t AND category = 'export' ORDER BY id",
        t=portal_chart.practice.clinic)
    assert [(r.action, r.actor_type, r.patient_id) for r in audited] == [
        ("export", "patient", a), ("export", "patient", a)]           # the link, the download
    assert audited[0].reason == "format pdf"
    assert audited[1].entity_id == str(file_id)
    for r in audited:
        said = " ".join(str(v) for v in r)
        assert "Synth" not in said and token not in said and ".pdf" not in said


def test_every_other_export_and_token_is_the_same_404(
        portal_app: Any, portal_chart: PortalChart, files: dict[str, Any]) -> None:
    a, b, clinic = portal_chart.a, portal_chart.b, portal_chart.practice.clinic
    me, them = (portal_client(portal_app, portal_chart, p) for p in (a, b))
    mine = _ask(me).json()
    file_id = uuid.UUID(urlsplit(mine["url"]).path.split("/")[-2])
    tokens: PortalDownloadTokens = files["tokens"]

    def link(patient: uuid.UUID) -> str:
        token = tokens.sign(tokens.claims(file_id, patient, clinic))
        return f"/api/v1/portal/me/files/{file_id}/content?token={token}"

    assert them.get(link(b)).status_code == 404        # her export, his own valid token
    assert them.get(mine["url"]).status_code == 404     # her token, his session
    assert me.get(mine["url"]).status_code == 200       # not used up by his attempt
    _sql(portal_chart, "UPDATE admin.portal_record_export SET created_at = now() - interval "
         "'20 minutes', expires_at = now() - interval '5 minutes' WHERE binary_object_id = :f",
         f=file_id)
    got = me.get(link(a))                               # a fresh token for an expired export
    assert got.status_code == 404 and got.json()["code"] == "not-found"


def test_fhir_is_refused_for_now_and_the_format_is_required(
        portal_app: Any, portal_chart: PortalChart, files: dict[str, Any]) -> None:
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    refused = _ask(me, "fhir-r4")
    assert refused.status_code == 422
    body = refused.json()
    assert body["code"] == "validation-failed"
    assert body["errors"] == [{"in": "query", "name": "format", "code": "not-allowed-value"}]
    assert _ask(me, None).status_code == 422
    assert _ask(me, "docx").status_code == 422
    assert not _export_rows(portal_chart.practice.clinic) and not files["store"].objects


def test_the_size_limits(portal_app: Any, portal_chart: PortalChart, files: dict[str, Any],
                         monkeypatch: pytest.MonkeyPatch) -> None:
    _chart_items(portal_chart)
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    monkeypatch.setattr(records_service, "MAX_PDF_BYTES", 2000)
    too_big = _ask(me)
    assert too_big.status_code == 422, too_big.text
    assert too_big.json()["code"] == "business-rule-violation"
    assert too_big.json()["errors"] == [{"in": "query", "name": "format",
                                         "code": "out-of-range"}]
    assert not _export_rows(portal_chart.practice.clinic) and not files["store"].objects
    monkeypatch.setattr(records_service, "MAX_PDF_BYTES", 4 * 1024 * 1024)
    monkeypatch.setattr(records_service, "SECTION_LIMIT", 1)
    _sql(portal_chart, """INSERT INTO clinical.allergy_intolerance (id, tenant_id, patient_id,
                          clinical_status, verification_status, code_text, recorded_date)
                          VALUES (:i, :t, :p, 'active', 'confirmed', 'Synthlatex401', now())""",
         i=uuid.uuid4(), t=portal_chart.practice.clinic, p=portal_chart.a)
    pdf = _download(me, _ask(me).json()).content.decode("latin-1")
    assert "Synthlatex401" in pdf and "Synthpeanut401" not in pdf     # the newest one only
    assert "Only the 1 most recent are listed." in pdf


def test_a_staff_session_is_refused(portal_app: Any, portal_chart: PortalChart,
                                    files: dict[str, Any]) -> None:
    staff = portal_app.get(API, params={"format": "pdf"}, headers={"X-Dev-User": "md"})
    assert staff.status_code in (401, 403), staff.status_code
    assert not _export_rows(portal_chart.practice.clinic)
