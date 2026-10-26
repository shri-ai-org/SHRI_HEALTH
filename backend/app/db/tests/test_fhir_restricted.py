"""Restricted charts are never served on /fhir (D22; migration 0006, follow-up b).

Everything here runs as ``shri_fhir_reader``, the role /fhir runs as: through the facade, or
with SET ROLE inside a transaction that is rolled back. Audit rows are read back as the
superuser, since the reader may only insert them.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, Table, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db.base import CLINICAL_SCHEMA
from app.db.constraints import patient_column, referenced_table
from app.db.models import FHIR_RESOURCES, MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests import test_fhir_facade as facade
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, open_session
from app.db.tools.gen_db_rules import FHIR_PATIENTLESS, FHIR_POLYMORPHIC, fhir_visibility_rules

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
M = MAPPERS
chart = facade.chart   # the same one-patient chart fixture, touching every FHIR resource table

FUNCTION = "audit.record_fhir_lookup_denied(text, uuid)"
CLINICAL = {name: cls.__table__ for name, cls in MAPPERS.items()
            if cls.__table__.schema == CLINICAL_SCHEMA}


@pytest.fixture
def client(chart: dict[str, Any], db: Session) -> Iterator[TestClient]:
    yield from facade.facade_client(chart, db)


def restrict(db: Session, chart: dict[str, Any]) -> uuid.UUID:
    pt = chart["patient"]
    pt.meta_security = ["R"]
    db.commit()
    return pt.id  # type: ignore[no-any-return]


def audit_rows(admin_engine: Engine, entity_id: uuid.UUID) -> list[dict[str, Any]]:
    with admin_engine.connect() as c:
        rows = c.execute(text(
            "SELECT action, category, outcome, reason, patient_id, entity_type FROM "
            "audit.audit_event WHERE entity_id = :e ORDER BY id"), {"e": str(entity_id)})
        return [dict(r._mapping) for r in rows]


RESTRICTED_ROW = {"action": "access-denied", "category": "security", "outcome": "denied",
                  "reason": "restricted"}
NOT_FOUND_ROW = {"action": "read", "category": "phi-read", "outcome": "failure",
                 "reason": "not-found", "patient_id": None}


# =============================================================================== the facade
@pytest.mark.parametrize("path", [
    "{rtype}/{id}", "{rtype}/{id}/_history", "{rtype}/{id}/_history/1"])
@pytest.mark.parametrize("which", ["patient", "observation"])
def test_restricted_and_missing_get_the_same_404(client: TestClient, chart: dict[str, Any],
                                                db: Session, admin_engine: Engine,
                                                path: str, which: str) -> None:
    rtype = "Patient" if which == "patient" else "Observation"
    real = chart[which].id
    made_up = uuid.uuid4()
    url = "/fhir/r4/" + path
    assert client.get(url.format(rtype=rtype, id=real)).status_code == 200   # served until...
    pid = restrict(db, chart)

    restricted = client.get(url.format(rtype=rtype, id=real))
    missing = client.get(url.format(rtype=rtype, id=made_up))
    assert restricted.status_code == missing.status_code == 404
    assert restricted.headers["content-type"] == missing.headers["content-type"]
    assert restricted.text.replace(str(real), "ID") == missing.text.replace(str(made_up), "ID")

    assert audit_rows(admin_engine, real)[-1] == {**RESTRICTED_ROW, "patient_id": pid,
                                                  "entity_type": rtype}
    assert audit_rows(admin_engine, made_up) == [{**NOT_FOUND_ROW, "entity_type": rtype}]


def test_missing_version_of_a_served_resource_is_a_plain_404(
        client: TestClient, chart: dict[str, Any], admin_engine: Engine) -> None:
    obs = chart["observation"]
    r = client.get(f"/fhir/r4/Observation/{obs.id}/_history/999")
    assert r.status_code == 404
    assert all(row["reason"] != "not-found" for row in audit_rows(admin_engine, obs.id))


def test_search_leaves_restricted_charts_out(client: TestClient, chart: dict[str, Any],
                                             db: Session, admin_engine: Engine) -> None:
    by_name = {"family": "Ngu"}
    assert client.post("/fhir/r4/Patient/_search", json=by_name).json()["total"] == 1
    pid = restrict(db, chart)
    found = client.post("/fhir/r4/Patient/_search", json=by_name).json()
    assert found["total"] == 0 and found.get("entry") == []

    # Naming the chart in the search: the same answer as for a patient that does not exist.
    made_up = uuid.uuid4()
    for rtype in ("Observation", "Patient"):
        restricted = client.post(f"/fhir/r4/{rtype}/_search",
                                 json={"patient": f"Patient/{pid}"})
        missing = client.post(f"/fhir/r4/{rtype}/_search",
                              json={"patient": f"Patient/{made_up}"})
        assert restricted.status_code == missing.status_code == 200
        assert restricted.json() == missing.json()
        assert restricted.json()["total"] == 0
    assert [r["reason"] for r in audit_rows(admin_engine, pid)][-2:] == ["restricted"] * 2
    assert [r["reason"] for r in audit_rows(admin_engine, made_up)] == ["not-found"] * 2


def test_search_without_a_patient_leaves_restricted_charts_out(
        client: TestClient, chart: dict[str, Any], db: Session) -> None:
    """Vimal's case on #45: a search on another type with no patient parameter (Observation by
    code) must not return the restricted chart's rows, nor count them in the total."""
    by_code = {"code": f"{systems.LOINC}|85354-9"}
    before = client.post("/fhir/r4/Observation/_search", json=by_code).json()
    assert before["total"] == 1
    restrict(db, chart)
    after = client.post("/fhir/r4/Observation/_search", json=by_code).json()
    assert after["total"] == 0 and after.get("entry") == []


@pytest.mark.parametrize("parameter", ["_include", "_revinclude", "_has", "subject:Patient.name"])
def test_unsupported_search_parameters_are_refused(client: TestClient, parameter: str) -> None:
    r = client.post("/fhir/r4/Observation/_search",
                    json={parameter: "Observation:patient-secret-value"})
    assert r.status_code == 400 and r.headers["content-type"].startswith("application/fhir+json")
    body = r.json()
    assert body["resourceType"] == "OperationOutcome"
    assert body["issue"][0]["code"] == "not-supported"
    assert parameter in r.text and "secret-value" not in r.text   # names, never values (D13)


# ============================================================ the database, as the reader
def _parents(name: str) -> list[tuple[str, str]]:
    """(column, table) for each link through which a row of this table can belong to a chart:
    its patient column and its parent row(s), from the models."""
    table: Table = CLINICAL[name]
    pcol = patient_column(table)
    cols = [pcol.name] if pcol is not None else []
    cols += [c for c in getattr(MAPPERS[name], "fhir_parent", ()) if c not in cols]
    return [(c, referenced_table(table.c[c]).name) for c in cols]


def _still_visible_sql(name: str) -> str:
    """As the superuser, with no RLS involved: the rows of this table that are not part of the
    restricted patient's chart, when that patient is the only one in the clinic. Worked out
    from the model links, independently of the policies under test."""
    if name == "patient":
        return "false"
    if name in FHIR_POLYMORPHIC:
        type_col, id_col = FHIR_POLYMORPHIC[name]
        whens = " ".join(
            f"WHEN '{rtype}' THEN {id_col} IN (SELECT id FROM {CLINICAL_SCHEMA}."  # noqa: S608
            f"{cls.__table__.name} WHERE {_still_visible_sql(cls.__table__.name)})"
            for rtype, cls in sorted(FHIR_RESOURCES.items()) if cls.__table__.name != name)
        return f"CASE {type_col} {whens} ELSE false END"
    parts = [f"({col} IS NULL OR {col} IN (SELECT id FROM {CLINICAL_SCHEMA}.{target} "  # noqa: S608
             f"WHERE {_still_visible_sql(target)}))"
             for col, target in _parents(name)]
    return " AND ".join(parts) or "true"


def _counts(conn: Connection, tenant: uuid.UUID, *, expected: bool = False) -> dict[str, int]:
    """Rows of the clinic in each table with the policy: all that ``conn`` can see, or (as the
    superuser, ``expected=True``) those outside the restricted chart."""
    conn.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": str(tenant)})
    counts = {}
    for name in sorted(fhir_visibility_rules()):
        where = _still_visible_sql(name) if expected else "true"
        counts[name] = conn.execute(text(
            f"SELECT count(*) FROM {CLINICAL_SCHEMA}.{name} "  # noqa: S608  (model names)
            f"WHERE tenant_id = :t AND ({where})"), {"t": tenant}).scalar_one()
    return counts


def test_reader_sees_nothing_of_a_restricted_chart_and_everything_else(
        chart: dict[str, Any], db: Session, admin_engine: Engine) -> None:
    """The clinic of ``chart`` holds one patient's chart (touching every FHIR resource table)
    plus the practice's own records (practitioners, organization, locations, medications).
    Before: the reader sees every row. After restricting the patient: exactly the rows that
    are not part of that chart, table by table, including the shared child tables (names,
    identifiers, addresses) and the history and provenance rows by resource type."""
    tenant = db.info["tenant_id"]
    db.commit()
    with admin_engine.connect() as conn:
        everything = _counts(conn, tenant)
        expected_after = _counts(conn, tenant, expected=True)
        conn.execute(text("SET LOCAL ROLE shri_fhir_reader"))
        assert _counts(conn, tenant) == everything            # nothing hidden while unrestricted
        conn.rollback()
    restrict(db, chart)
    with admin_engine.connect() as conn:
        conn.execute(text("SET LOCAL ROLE shri_fhir_reader"))
        after = _counts(conn, tenant)
        conn.rollback()
    assert after == expected_after
    assert after["patient"] == after["observation"] == after["provenance"] == 0
    assert sum(everything.values()) > sum(after.values()) > 0   # hid the chart, kept the rest


def test_api_still_sees_restricted_charts(chart: dict[str, Any], db: Session,
                                          app_engine: Engine) -> None:
    """The policies are for shri_fhir_reader only: in the API, break-glass decides (D37)."""
    pid = restrict(db, chart)
    s = open_session(app_engine, db.info["tenant_id"])
    try:
        assert s.execute(text("SELECT count(*) FROM clinical.patient WHERE id = :p"),
                         {"p": pid}).scalar_one() == 1
    finally:
        s.close()


# ======================================================================= the audit function
def _call_as_reader(conn: Connection, tenant: uuid.UUID | None, rtype: str,
                    rid: uuid.UUID) -> str | None:
    """Calls the function as shri_fhir_reader; returns the SQLSTATE it fails with, or None."""
    if tenant is not None:
        conn.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                     {"t": str(tenant)})
    conn.execute(text("SET LOCAL ROLE shri_fhir_reader"))
    savepoint = conn.begin_nested()
    try:
        conn.execute(text("SELECT audit.record_fhir_lookup_denied(:r, :i)"),
                     {"r": rtype, "i": rid})
    except DBAPIError as err:
        savepoint.rollback()
        conn.execute(text("RESET ROLE"))
        return getattr(err.orig, "sqlstate", None)
    savepoint.commit()
    conn.execute(text("RESET ROLE"))
    return None


def _last_row(conn: Connection, rid: uuid.UUID) -> dict[str, Any]:
    return dict(conn.execute(text(
        "SELECT tenant_id, action, category, outcome, reason, patient_id FROM audit.audit_event "
        "WHERE entity_id = :e ORDER BY id DESC LIMIT 1"), {"e": str(rid)}).one()._mapping)


def test_function_shape(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        rettype, definer, owner, config = c.execute(text(
            "SELECT prorettype::regtype::text, prosecdef, pg_get_userbyid(proowner), proconfig "
            "FROM pg_proc WHERE oid = CAST(:f AS regprocedure)"), {"f": FUNCTION}).one()
        # void: a later change cannot quietly turn it into "is this patient restricted?"
        assert rettype == "void"
        assert definer and owner == "shri_migrator"
        assert config == ["search_path=pg_catalog, clinical, audit"]
        for role in ("shri_app", "shri_fhir_reader", "shri_integration", "shri_reporting"):
            assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                             {"r": role, "f": FUNCTION}).scalar_one() == (
                role == "shri_fhir_reader"), role


def test_function_records_restricted_or_not_found_in_the_callers_clinic_only(
        chart: dict[str, Any], db: Session, admin_engine: Engine, app_engine: Engine) -> None:
    pid = restrict(db, chart)
    tenant = db.info["tenant_id"]
    note = chart["note"]
    prov_id = db.execute(text("SELECT id FROM clinical.provenance WHERE target_id = :n"),
                         {"n": note.id}).scalar_one()
    other = make_tenant(admin_engine)
    with admin_engine.connect() as conn:
        assert _call_as_reader(conn, tenant, "Patient", pid) is None
        assert _last_row(conn, pid) == {"tenant_id": tenant, **RESTRICTED_ROW, "patient_id": pid}
        # A resource of the chart, and a provenance about one, are restricted too.
        for rtype, rid in (("Composition", note.id), ("Provenance", prov_id)):
            assert _call_as_reader(conn, tenant, rtype, rid) is None
            assert _last_row(conn, rid)["reason"] == "restricted"
        # From another clinic, the same chart is simply not there.
        assert _call_as_reader(conn, other, "Patient", pid) is None
        assert _last_row(conn, pid) == {"tenant_id": other, **NOT_FOUND_ROW}
        conn.rollback()


def test_function_refuses_without_a_clinic_or_a_known_type(admin_engine: Engine,
                                                           tenant: uuid.UUID) -> None:
    with admin_engine.connect() as conn:
        assert _call_as_reader(conn, None, "Patient", uuid.uuid4()) == "42501"
        assert _call_as_reader(conn, tenant, "Basic", uuid.uuid4()) == "22023"
        assert _call_as_reader(conn, tenant, "patient", uuid.uuid4()) == "22023"
        conn.rollback()


def test_a_not_restricted_chart_is_recorded_as_not_found(admin_engine: Engine,
                                                         app_engine: Engine) -> None:
    """The function is only ever called for an ID the reader cannot see. If the chart is not
    restricted, it was not there for the reader at the time either way."""
    tenant = make_tenant(admin_engine)
    s = open_session(app_engine, tenant)
    try:
        pid = b.patient(s).id
        s.commit()
    finally:
        s.close()
    with admin_engine.connect() as conn:
        assert _call_as_reader(conn, tenant, "Patient", pid) is None
        assert _last_row(conn, pid)["reason"] == "not-found"
        conn.rollback()


# ================================================================== every table is covered
def test_every_clinical_table_with_a_chart_has_the_policy(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        policies = {r.tablename: r for r in c.execute(text(
            "SELECT tablename, permissive, roles, cmd FROM pg_policies "
            "WHERE schemaname = 'clinical' AND policyname = 'fhir_hide_restricted'"))}
    assert set(policies) == set(CLINICAL) - FHIR_PATIENTLESS
    assert all(p.permissive == "RESTRICTIVE" and list(p.roles) == ["shri_fhir_reader"]
               and p.cmd == "SELECT" for p in policies.values())
    # The tables left without one really have no patient below or above them.
    for name in FHIR_PATIENTLESS:
        assert not _parents(name) and name not in FHIR_POLYMORPHIC


# ===================================================== errors on the wire (Vimal's review, #45)
def _is_outcome(r: Any, status: int) -> dict[str, Any]:
    assert r.status_code == status, r.text
    assert r.headers["content-type"].startswith("application/fhir+json")
    body: dict[str, Any] = r.json()
    assert body["resourceType"] == "OperationOutcome" and body["issue"]
    return body


def test_every_error_is_an_operation_outcome(client: TestClient) -> None:
    _is_outcome(client.post("/fhir/r4/Observation/_search", json={"_include": "x"}), 400)
    _is_outcome(client.get(f"/fhir/r4/Patient/{uuid.uuid4()}"), 404)
    _is_outcome(client.get(f"/fhir/r4/Basic/{uuid.uuid4()}"), 404)
    _is_outcome(client.get("/fhir/r4/Patient/not-a-uuid"), 422)
    _is_outcome(client.post("/fhir/r4/Patient/_search", content=b"{not json",
                            headers={"content-type": "application/json"}), 422)


@pytest.mark.parametrize("count", [0, -1])
def test_count_must_be_at_least_one(client: TestClient, count: int) -> None:
    body = _is_outcome(client.post("/fhir/r4/Patient/_search", json={"count": count}), 422)
    assert "count" in body["issue"][0]["diagnostics"]


def test_validation_errors_never_echo_what_was_sent(client: TestClient) -> None:
    r = client.post("/fhir/r4/Patient/_search",
                    json={"family": "Okafor", "birthdate": "Secret-1984-not-a-date"})
    body = _is_outcome(r, 422)
    assert "birthdate" in body["issue"][0]["diagnostics"]
    assert "Secret" not in r.text and "Okafor" not in r.text


# ===================================================== one audit row per patient (as D54)
def test_a_search_audits_each_patient_it_returns(client: TestClient, chart: dict[str, Any],
                                                 db: Session, admin_engine: Engine) -> None:
    second = b.patient(db, given="Linh")
    db.commit()
    found = client.post("/fhir/r4/Patient/_search", json={"family": "Ngu"}).json()
    ids = {e["resource"]["id"] for e in found["entry"]}
    assert ids == {str(chart["patient"].id), str(second.id)}
    with admin_engine.connect() as c:
        audited = c.execute(text(
            "SELECT patient_id FROM audit.audit_event WHERE tenant_id = :t AND action = 'read' "
            "AND entity_type = 'Patient' AND reason = 'search params: family'"),
            {"t": db.info["tenant_id"]}).scalars().all()
    assert sorted(map(str, audited)) == sorted(ids)
    # A search that returns no patient data writes one row, without a patient.
    client.post("/fhir/r4/Practitioner/_search", json={})
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT patient_id FROM audit.audit_event WHERE tenant_id = :t "
                              "AND entity_type = 'Practitioner'"),
                         {"t": db.info["tenant_id"]}).scalars().all()
    assert rows == [None]


# ================================ references to a restricted patient (D22 as amended on #13)
def _coverage(db: Session, chart: dict[str, Any]) -> Any:
    return db.execute(select(M["coverage"]).where(
        M["coverage"].beneficiary_patient_id == chart["patient"].id)).scalar_one()


def _restricted_other(db: Session) -> Any:
    other = b.patient(db, family="Okafor", given="Ada")
    db.flush()
    return other


def _restrict(db: Session, pt: Any) -> None:
    pt.meta_security = ["R"]
    db.commit()


def _never_hinted(text_: str, other: Any) -> None:
    """Nothing says something was left out: no ID, no masked marker (Thulasi, Vimal on #13)."""
    assert str(other.id) not in text_
    assert "masked" not in text_ and "data-absent-reason" not in text_


def test_an_optional_reference_to_a_restricted_patient_is_left_out(
        client: TestClient, chart: dict[str, Any], db: Session) -> None:
    """Thulasi's first case: a coverage whose subscriber is restricted is served without
    `subscriber`, by read and by search."""
    cov, other = _coverage(db, chart), _restricted_other(db)
    cov.subscriber_patient_id = other.id
    db.commit()
    assert client.get(f"/fhir/r4/Coverage/{cov.id}").json()["subscriber"]["reference"] \
        == f"Patient/{other.id}"                                     # served while visible
    _restrict(db, other)
    r = client.get(f"/fhir/r4/Coverage/{cov.id}")
    assert r.status_code == 200 and "subscriber" not in r.json()
    _never_hinted(r.text, other)
    found = client.post("/fhir/r4/Coverage/_search",
                        json={"patient": f"Patient/{chart['patient'].id}"})
    assert found.json()["total"] == 1 and "subscriber" not in found.json()["entry"][0]["resource"]
    _never_hinted(found.text, other)


def test_a_resource_whose_required_reference_is_restricted_is_not_served(
        client: TestClient, chart: dict[str, Any], db: Session) -> None:
    """Thulasi's second case: Coverage.payor is required (1..*). When its only payor is a
    restricted patient, the coverage is a 404 on read and left out of search and its total."""
    cov, other = _coverage(db, chart), _restricted_other(db)
    made_up = uuid.uuid4()
    for payor in cov.payor:                      # the self-pay payor becomes the other patient
        payor.patient_id = other.id
    db.commit()
    assert client.get(f"/fhir/r4/Coverage/{cov.id}").status_code == 200   # served while visible
    _restrict(db, other)
    hidden = client.get(f"/fhir/r4/Coverage/{cov.id}")
    missing = client.get(f"/fhir/r4/Coverage/{made_up}")
    assert hidden.status_code == missing.status_code == 404
    assert hidden.text.replace(str(cov.id), "ID") == missing.text.replace(str(made_up), "ID")
    found = client.post("/fhir/r4/Coverage/_search",
                        json={"patient": f"Patient/{chart['patient'].id}"}).json()
    assert found["total"] == 0 and found.get("entry") == []


def test_includes_cannot_bring_in_a_restricted_patient(client: TestClient,
                                                      chart: dict[str, Any], db: Session) -> None:
    """Thulasi's third case: `_include=Coverage:subscriber` returns no Patient and the total
    doesn't count one. /fhir refuses includes altogether (400), so nothing comes back."""
    cov, other = _coverage(db, chart), _restricted_other(db)
    cov.subscriber_patient_id = other.id
    _restrict(db, other)
    r = client.post("/fhir/r4/Coverage/_search",
                    json={"patient": f"Patient/{chart['patient'].id}",
                          "_include": "Coverage:subscriber"})
    assert r.status_code == 400 and "Patient" not in r.text.replace("patient", "")
    _never_hinted(r.text, other)


def test_an_old_version_naming_a_now_restricted_patient_leaves_it_out(
        client: TestClient, chart: dict[str, Any], db: Session) -> None:
    """Thulasi's fourth case: today's restriction applies to history, not the one at the time."""
    cov, other = _coverage(db, chart), _restricted_other(db)
    cov.subscriber_patient_id = other.id
    db.commit()
    named = cov.meta_version_id
    cov.subscriber_patient_id = None
    db.commit()
    _restrict(db, other)
    old = client.get(f"/fhir/r4/Coverage/{cov.id}/_history/{named}")
    assert old.status_code == 200 and "subscriber" not in old.json()
    history = client.get(f"/fhir/r4/Coverage/{cov.id}/_history")
    assert history.status_code == 200 and history.json()["total"] >= 2
    _never_hinted(old.text + history.text, other)


def test_a_link_to_a_restricted_patient_is_left_out_with_its_entry(
        client: TestClient, chart: dict[str, Any], db: Session) -> None:
    """Patient.link.other is required inside a link, so the whole link entry goes."""
    pt, other = chart["patient"], _restricted_other(db)
    db.add(M["patient_link"](patient_id=pt.id, other_patient_id=other.id, type="seealso"))
    db.commit()
    assert "link" in client.get(f"/fhir/r4/Patient/{pt.id}").json()
    _restrict(db, other)
    r = client.get(f"/fhir/r4/Patient/{pt.id}")
    assert r.status_code == 200 and "link" not in r.json()
    _never_hinted(r.text, other)


# The stripping rules themselves, without a database.
def _ref(rtype: str, rid: str) -> dict[str, str]:
    return {"reference": f"{rtype}/{rid}"}


HIDDEN_ID, SEEN_ID = str(uuid.UUID(int=1)), str(uuid.UUID(int=2))


@pytest.mark.parametrize(("resource", "expected"), [
    # an optional reference goes, the rest stays
    ({"resourceType": "Condition", "id": "c", "recorder": _ref("Patient", HIDDEN_ID),
      "subject": _ref("Patient", SEEN_ID)},
     {"resourceType": "Condition", "id": "c", "subject": _ref("Patient", SEEN_ID)}),
    # one of several performers
    ({"resourceType": "Observation", "id": "o",
      "performer": [_ref("Patient", HIDDEN_ID), _ref("Practitioner", SEEN_ID)]},
     {"resourceType": "Observation", "id": "o", "performer": [_ref("Practitioner", SEEN_ID)]}),
    # inside an annotation: the author goes, the required text stays
    ({"resourceType": "Condition", "id": "c",
      "note": [{"authorReference": _ref("Patient", HIDDEN_ID), "text": "t"}]},
     {"resourceType": "Condition", "id": "c", "note": [{"text": "t"}]}),
    # a required reference inside a repeating element takes the element with it
    ({"resourceType": "Provenance", "id": "p", "target": [_ref("Patient", SEEN_ID)],
      "agent": [{"who": _ref("Patient", HIDDEN_ID)}, {"who": _ref("Practitioner", SEEN_ID)}]},
     {"resourceType": "Provenance", "id": "p", "target": [_ref("Patient", SEEN_ID)],
      "agent": [{"who": _ref("Practitioner", SEEN_ID)}]}),
    # ...and when that leaves a required element empty, the resource is not served
    ({"resourceType": "Provenance", "id": "p", "target": [_ref("Patient", SEEN_ID)],
      "agent": [{"who": _ref("Patient", HIDDEN_ID)}]}, None),
    ({"resourceType": "MedicationRequest", "id": "m", "requester": _ref("Patient", HIDDEN_ID),
      "subject": _ref("Patient", SEEN_ID)}, None),
    # a contained resource is checked like any other part
    ({"resourceType": "Condition", "id": "c",
      "contained": [{"resourceType": "Provenance", "id": "x", "agent": [
          {"who": _ref("Patient", HIDDEN_ID)}, {"who": _ref("Practitioner", SEEN_ID)}]}]},
     {"resourceType": "Condition", "id": "c", "contained": [
         {"resourceType": "Provenance", "id": "x", "agent": [
             {"who": _ref("Practitioner", SEEN_ID)}]}]}),
])
def test_strip_hidden(resource: dict[str, Any], expected: dict[str, Any] | None) -> None:
    from app.fhir.api import strip_hidden

    assert strip_hidden(resource, {("Patient", HIDDEN_ID)}) == expected
