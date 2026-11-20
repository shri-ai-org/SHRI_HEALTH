"""Migration 0032: "My records" exports. admin.portal_record_export() records the file the API
stored (purpose export, clean without a scan) and its export row, as shri_portal, for the session
patient only; admin.portal_file() serves it to her until it expires; the maintenance job's two
functions remove exports 24 hours after their expiry and nothing else. No service role holds a
privilege on the new table, and shri_portal still none on binary_object. Run as the real roles
against the real database. Synthetic data only."""
from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import NullPool

from app.db.tests.conftest import SERVICE_ROLES, SKIP_WITHOUT_DATABASE, switch_to_role, sync_url
from app.db.tests.test_portal_access import _as_patient, chart, portal_engine

__all__ = ["chart", "portal_engine"]       # fixtures, used by name
pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

PORTAL_FUNCTIONS = {"admin.portal_clinic()",
                    "admin.portal_record_export(uuid,text,text,text,bigint,text)",
                    "admin.portal_file(uuid)"}
MAINTENANCE_FUNCTIONS = {"admin.list_expired_exports(integer)",
                         "admin.delete_expired_exports(uuid[])"}
DATA = b"%PDF-1.4 synthetic export for tests"


@pytest.fixture(scope="module")
def maintenance_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_maintenance", require_search_path=False)
    yield engine
    engine.dispose()


def _refusal(c: Connection, sql: str, params: dict[str, Any]) -> tuple[str, str | None]:
    savepoint = c.begin_nested()
    with pytest.raises(DBAPIError) as err:
        c.execute(text(sql), params)
    savepoint.rollback()
    orig: Any = err.value.orig
    return orig.sqlstate, orig.diag.constraint_name


RECORD = "SELECT admin.portal_record_export(:f, :fmt, :k, :w, :n, :h)"


def _params(chart: dict[str, Any], file_id: uuid.UUID | None = None, **kw: Any
            ) -> dict[str, Any]:
    file_id = file_id or uuid.uuid4()
    return {"f": file_id, "fmt": "pdf", "k": f"{chart['tenant']}/{file_id}",
            "w": "vault:v1:test-wrapped-key", "n": len(DATA),
            "h": hashlib.sha256(DATA).hexdigest()} | kw


def _export(portal_engine: Engine, chart: dict[str, Any], who: str = "me") -> uuid.UUID:
    params = _params(chart)
    with portal_engine.begin() as c:
        _as_patient(c, chart, who)
        c.execute(text(RECORD), params)
    file_id: uuid.UUID = params["f"]
    return file_id


def _served(portal_engine: Engine, chart: dict[str, Any], file_id: uuid.UUID,
            who: str = "me") -> list[Any]:
    with portal_engine.begin() as c:
        _as_patient(c, chart, who)
        return list(c.execute(text("SELECT * FROM admin.portal_file(:f)"), {"f": file_id}))


def _age(admin_engine: Engine, file_id: uuid.UUID, minutes_past_expiry: int) -> None:
    """Moves an export's times back, as if made long ago, its file's retention with it."""
    with admin_engine.begin() as c:
        params = {"f": file_id, "m": minutes_past_expiry}
        c.execute(text("""
            UPDATE admin.portal_record_export
               SET created_at = now() - make_interval(mins => :m + 15),
                   expires_at = now() - make_interval(mins => :m)
             WHERE binary_object_id = :f"""), params)
        c.execute(text("""
            UPDATE admin.binary_object
               SET retention_until = now() - make_interval(mins => :m) + interval '24 hours'
             WHERE id = :f"""), params)


def test_the_patient_records_her_export_and_only_she_downloads_it_until_it_expires(
        portal_engine: Engine, admin_engine: Engine, chart: dict[str, Any]) -> None:
    file_id = _export(portal_engine, chart)
    with admin_engine.connect() as c:
        b = c.execute(text("SELECT * FROM admin.binary_object WHERE id = :f"),
                      {"f": file_id}).one()
        e = c.execute(text("SELECT * FROM admin.portal_record_export "
                           "WHERE binary_object_id = :f"), {"f": file_id}).one()
    assert (b.purpose, b.state, b.scan_status, b.bucket, b.content_type, b.size_bytes,
            b.created_by_user_id) == ("export", "clean", "pending", "clean", "application/pdf",
                                      len(DATA), None)
    assert (e.tenant_id, e.patient_id, e.format) == (chart["tenant"], chart["me"]["pt"].id,
                                                     "pdf")
    assert (e.expires_at - e.created_at).total_seconds() == 15 * 60
    assert (b.retention_until - e.expires_at).total_seconds() == 24 * 3600
    (row,) = _served(portal_engine, chart, file_id)
    assert (row.id, row.purpose, row.storage_key, row.document_reference_id) == (
        file_id, "export", f"{chart['tenant']}/{file_id}", None)
    assert _served(portal_engine, chart, file_id, "other") == []    # another patient's
    _age(admin_engine, file_id, 1)
    assert _served(portal_engine, chart, file_id) == []             # expired


def test_the_function_refuses_what_is_not_a_stored_export_of_hers(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    other_clinic = uuid.uuid4()
    with portal_engine.begin() as c:
        assert _refusal(c, RECORD, _params(chart)) == ("P0002", None)  # no session patient
        _as_patient(c, chart)
        bad = {
            "portal_record_export_format": _params(chart, fmt="docx"),
            "portal_record_export_file": _params(chart, k=f"{other_clinic}/{uuid.uuid4()}"),
        }
        for constraint, params in bad.items():
            assert _refusal(c, RECORD, params) == ("P0001", constraint), constraint
        for params in (_params(chart, w=" "), _params(chart, n=0),
                       _params(chart, n=10 * 1024 * 1024 + 1)):
            assert _refusal(c, RECORD, params) == ("P0001", "portal_record_export_file")


def test_a_patient_makes_at_most_ten_exports_an_hour(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    for _ in range(10):
        _export(portal_engine, chart)
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert _refusal(c, RECORD, _params(chart)) == (
            "P0001", "portal_record_export_rate_limited")
    _export(portal_engine, chart, "other")                           # each patient her own


def test_the_clinic_header_is_the_session_clinics(portal_engine: Engine,
                                                  chart: dict[str, Any]) -> None:
    with portal_engine.begin() as c:
        assert c.execute(text("SELECT * FROM admin.portal_clinic()")).all() == []
        _as_patient(c, chart)
        (row,) = c.execute(text("SELECT * FROM admin.portal_clinic()")).all()
    assert row.name == "Test practice" and row.timezone


def test_the_purge_removes_only_exports_a_day_past_their_expiry(
        portal_engine: Engine, admin_engine: Engine, maintenance_engine: Engine,
        chart: dict[str, Any]) -> None:
    old, recent, fresh = (_export(portal_engine, chart) for _ in range(3))
    _age(admin_engine, old, 24 * 60 + 1)                             # a day and a minute ago
    _age(admin_engine, recent, 24 * 60 - 5)                          # not a full day yet
    other = uuid.uuid4()   # an old clean file of another purpose: never the export purge's
    with admin_engine.begin() as c:
        c.execute(text(
            "INSERT INTO admin.binary_object (id, tenant_id, bucket, storage_key, content_type, "
            "size_bytes, sha256, purpose, state, scan_status, wrapped_data_key, created_at, "
            "updated_at, retention_until) VALUES (:i, :t, 'clean', :k, 'application/pdf', 1, "
            ":h, 'after-visit-summary', 'clean', 'pending', 'vault:v1:k', now() - interval "
            "'3 days', now() - interval '3 days', now() - interval '2 days')"),
            {"i": other, "t": chart["tenant"], "k": f"{chart['tenant']}/{other}", "h": "a" * 64})
    with maintenance_engine.begin() as c:
        listed = c.execute(text("SELECT * FROM admin.list_expired_exports(1000)")).all()
        assert old in {r.id for r in listed}
        assert not {recent, fresh, other} & {r.id for r in listed}
        (row,) = [r for r in listed if r.id == old]
        assert (row.tenant_id, row.bucket, row.storage_key) == (
            chart["tenant"], "clean", f"{chart['tenant']}/{old}")
        deleted = {r.id for r in c.execute(text(
            "SELECT id FROM admin.delete_expired_exports(:ids)"),
            {"ids": [old, recent, fresh, other]})}
    assert deleted == {old}
    with admin_engine.connect() as c:
        left = {r.id for r in c.execute(text(
            "SELECT id FROM admin.binary_object WHERE id = ANY(:ids)"),
            {"ids": [old, recent, fresh, other]})}
        exports = {r.binary_object_id for r in c.execute(text(
            "SELECT binary_object_id FROM admin.portal_record_export "
            "WHERE binary_object_id = ANY(:ids)"), {"ids": [old, recent, fresh]})}
    assert left == {recent, fresh, other} and exports == {recent, fresh}
    with maintenance_engine.begin() as c:
        for sql in ("SELECT * FROM admin.list_expired_exports(0)",
                    "SELECT * FROM admin.list_expired_exports(1001)"):
            assert _refusal(c, sql, {})[0] == "22023"


def test_only_the_functions_reach_the_exports(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        for role in SERVICE_ROLES:
            tables = ["admin.portal_record_export"] + (
                ["admin.binary_object"] if role == "shri_portal" else [])
            for table in tables:
                assert not c.execute(text(
                    "SELECT has_table_privilege(:r, :t, 'SELECT') OR has_table_privilege(:r, :t, "
                    "'INSERT') OR has_table_privilege(:r, :t, 'UPDATE') OR "
                    "has_table_privilege(:r, :t, 'DELETE')"), {"r": role, "t": table}).scalar(), (
                    role, table)
        assert c.execute(text("SELECT relforcerowsecurity FROM pg_class WHERE oid = "
                              "'admin.portal_record_export'::regclass")).scalar()
        rows = c.execute(text(
            "SELECT p.oid::regprocedure::text AS name, p.prosecdef, p.proconfig, "
            "pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl FROM pg_proc p "
            "WHERE p.oid::regprocedure::text = ANY(:names)"),
            {"names": sorted(PORTAL_FUNCTIONS | MAINTENANCE_FUNCTIONS)}).all()
        assert {r.name for r in rows} == PORTAL_FUNCTIONS | MAINTENANCE_FUNCTIONS
        for r in rows:
            assert r.prosecdef and r.owner == "shri_migrator", r.name
            assert r.proconfig == ["search_path=pg_catalog, pg_temp"], r.name
            assert not any(e.startswith("=") for e in r.acl.strip("{}").split(",")), r.name
            mine = "shri_portal" if r.name in PORTAL_FUNCTIONS else "shri_maintenance"
            for role in SERVICE_ROLES:
                assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                                 {"r": role, "f": r.name}).scalar() == (role == mine), (
                    role, r.name)
