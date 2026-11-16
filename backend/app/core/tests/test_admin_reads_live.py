"""The read-only administration and interoperability screens against a live database, as
``shri_app``: listRoles, listUsers, listAuditEvents (core/admin_api.py),
listIntegrationMessages and getPatientFhirRecord (integration/admin_api.py). Each gets a
success, a permission-denied and a validation case, and the clinic boundary. Synthetic data
only."""
# ruff: noqa: F811 (scheduling's live fixtures are parameters here)

from __future__ import annotations

import datetime as dt
import json
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import DEV_USERS, CurrentUser
from app.core.routing import API_PREFIX
from app.db.models import MAPPERS
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    make_client,
    practice,
    setup_session,
    users,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

M = MAPPERS
TODAY = dt.datetime.now(dt.UTC).date()


@pytest.fixture
def staff(practice: Practice, users: dict[str, CurrentUser]) -> dict[str, CurrentUser]:
    """The practice's users plus a compliance officer (CO), and each user's role rows."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        co = M["app_user"](tenant_id=practice.clinic, keycloak_subject=str(uuid.uuid4()),
                           username=f"co.{uuid.uuid4().hex[:8]}", display_name="Dev CO")
        db.add(co)
        db.flush()
        found = dict(users)
        found["co"] = CurrentUser(id=co.id, organization_id=practice.clinic,
                                  roles=DEV_USERS["co"].roles,
                                  facility_ids=frozenset({practice.facility}),
                                  display_name="Dev CO")
        for name in ("md", "adm", "co"):
            for role in found[name].roles:
                db.execute(text("INSERT INTO admin.user_role (id, tenant_id, user_id, role_id) "
                                "SELECT gen_random_uuid(), :t, :u, r.id FROM admin.role r "
                                "WHERE r.code = :c"),
                           {"t": practice.clinic, "u": found[name].id, "c": role})
        db.commit()
        return found
    finally:
        db.close()
        admin.dispose()


@pytest.fixture
def client(staff: dict[str, CurrentUser]) -> Iterator[Callable[[str], Any]]:
    yield from make_client(staff, pending=False)


def _messages(practice: Practice) -> dict[str, uuid.UUID]:
    """A simulated pharmacy connection with two messages, in clinic A, and one in clinic B."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    ids: dict[str, uuid.UUID] = {}
    try:
        with admin.begin() as c:
            for clinic, key in ((practice.clinic, "a"), (practice.clinic_b, "b")):
                c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                          {"t": str(clinic)})
                endpoint = uuid.uuid4()
                c.execute(text("INSERT INTO admin.integration_endpoint (id, tenant_id, kind, "
                               "adapter, name, environment, baa_on_file, is_active) VALUES "
                               "(:i, :t, 'erx', 'simulated-erx', 'Simulated pharmacy', 'test', "
                               "false, true)"), {"i": endpoint, "t": clinic})
                for status, payload, ack in (
                        ("acknowledged", {"prescriptionId": str(uuid.uuid4())}, None),
                        ("failed", {"prescriptionId": "not-a-uuid"}, "AE")):
                    message = uuid.uuid4()
                    c.execute(text(
                        "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, "
                        "direction, message_type, status, payload, attempts, max_attempts, "
                        "ack_code, last_error) VALUES (:i, :t, :e, 'outbound', 'NewRx', :s, "
                        "CAST(:p AS jsonb), 1, 5, :a, 'free text that may name a patient')"),
                        {"i": message, "t": clinic, "e": endpoint, "s": status,
                         "p": json.dumps(payload), "a": ack})
                    ids[f"{key}-{status}"] = message
                    if status == "acknowledged":
                        ids[f"{key}-related"] = uuid.UUID(payload["prescriptionId"])
    finally:
        admin.dispose()
    return ids


# ------------------------------------------------------------------------------- listRoles
def test_roles_with_their_permissions_and_users(client: Any) -> None:
    found = client("adm").get(f"{API_PREFIX}/roles")
    assert found.status_code == 200, found.text
    roles = {r["code"]: r for r in found.json()["items"]}
    assert set(roles) >= {"FD", "MA", "RN", "MD", "APP", "BIL", "ADM", "CO", "SUP", "DSP"}
    assert roles["MD"]["name"] == "Physician"
    assert "prescriptions:sign-and-send" in roles["MD"]["permissions"]
    assert roles["DSP"]["permissions"] == ["status-board:read"]
    assert roles["MD"]["userCount"] >= 1 and roles["CO"]["userCount"] >= 1
    assert client("md").get(f"{API_PREFIX}/roles").json()["code"] == "permission-denied"


# ------------------------------------------------------------------------------- listUsers
def test_the_clinics_staff_with_their_roles(client: Any, staff: dict[str, CurrentUser]) -> None:
    found = client("adm").get(f"{API_PREFIX}/users", params={"limit": 100})
    assert found.status_code == 200, found.text
    listed = {u["id"]: u for u in found.json()["items"]}
    assert str(staff["md"].id) in listed and str(staff["md-b"].id) not in listed  # clinic A only
    md = listed[str(staff["md"].id)]
    assert md["roles"] == ["MD"] and md["active"] and md["practitionerId"]
    assert set(md) <= {"id", "displayName", "username", "roles", "facilityIds", "active",
                       "practitionerId", "lastSignInAt"}                   # no contact details
    by_role = client("adm").get(f"{API_PREFIX}/users", params={"role": "CO"}).json()["items"]
    assert [u["id"] for u in by_role] == [str(staff["co"].id)]
    named = client("adm").get(f"{API_PREFIX}/users", params={"q": "dev c"}).json()["items"]
    assert str(staff["co"].id) in {u["id"] for u in named}
    assert client("adm").get(f"{API_PREFIX}/users", params={"role": "XYZ"}).status_code == 422
    assert client("md").get(f"{API_PREFIX}/users").json()["code"] == "permission-denied"


# ------------------------------------------------------------------------- listAuditEvents
def test_the_audit_trail_with_break_glass(client: Any, practice: Practice,
                                         staff: dict[str, CurrentUser]) -> None:
    restricted = practice.patients["restricted"]
    md = client("md")
    assert md.get(f"{API_PREFIX}/patients/{restricted}").status_code == 403
    granted = md.post(f"{API_PREFIX}/patients/{restricted}/break-glass",
                      json={"reasonCode": "emergency-care"})
    assert granted.status_code == 200, granted.text
    assert md.get(f"{API_PREFIX}/patients/{restricted}").status_code == 200   # under the grant

    window = {"dateFrom": (TODAY - dt.timedelta(days=1)).isoformat(),
              "dateTo": (TODAY + dt.timedelta(days=1)).isoformat()}
    co = client("co")
    found = co.get(f"{API_PREFIX}/audit-events", params={**window, "patientId": str(restricted)})
    assert found.status_code == 200, found.text
    events = found.json()["items"]
    assert {e["outcome"] for e in events} >= {"denied", "success"}
    assert all(e["patientId"] == str(restricted) for e in events)
    assert all(set(e) <= {"id", "recordedAt", "actor", "action", "category", "outcome",
                          "patientId", "entityType", "entityId", "reason", "requestId",
                          "breakGlassGrantId"} for e in events)    # no patient name, ever
    only = co.get(f"{API_PREFIX}/audit-events", params={**window, "breakGlass": "true"}).json()
    kinds = {(e["category"], e["action"]) for e in only["items"]}
    assert ("security", "break-glass") in kinds                       # the grant itself
    assert ("phi-read", "read") in kinds                              # a read under it (ETREAT)
    assert all(e["actor"]["userId"] == str(staff["md"].id) for e in only["items"])
    mine = co.get(f"{API_PREFIX}/audit-events",
                  params={**window, "actorUserId": str(staff["md"].id), "limit": 1}).json()
    assert len(mine["items"]) == 1 and mine["nextCursor"]

    for bad in ({"dateFrom": "2026-11-20", "dateTo": "2026-11-01"},           # backwards
                {"dateFrom": "2026-10-01", "dateTo": "2026-11-20"},           # over 31 days
                {**window, "outcome": "error"}, {"dateFrom": "2026-11-01"}):  # no dateTo
        assert co.get(f"{API_PREFIX}/audit-events", params=bad).status_code == 422, bad
    assert client("adm").get(f"{API_PREFIX}/audit-events",
                             params=window).json()["code"] == "permission-denied"


def test_another_clinics_audit_events_never_show(client: Any, practice: Practice) -> None:
    client("md-b").get(f"{API_PREFIX}/patients/{practice.patients['restricted']}")  # B: 404
    window = {"dateFrom": (TODAY - dt.timedelta(days=1)).isoformat(),
              "dateTo": (TODAY + dt.timedelta(days=1)).isoformat()}
    events = client("co").get(f"{API_PREFIX}/audit-events", params=window).json()["items"]
    assert all(e["actor"].get("displayName") != "Dev MD (Clinic B)" for e in events)


# ----------------------------------------------------------------- listIntegrationMessages
def test_the_integration_monitor_shows_the_flow_never_the_payload(
        client: Any, practice: Practice) -> None:
    ids = _messages(practice)
    found = client("adm").get(f"{API_PREFIX}/admin/integration-messages")
    assert found.status_code == 200, found.text
    items = {m["id"]: m for m in found.json()["items"]}
    assert set(items) == {str(ids["a-acknowledged"]), str(ids["a-failed"])}   # clinic A only
    ok = items[str(ids["a-acknowledged"])]
    assert (ok["partner"], ok["endpointName"], ok["direction"], ok["messageType"],
            ok["status"]) == ("erx", "Simulated pharmacy", "outbound", "NewRx", "acknowledged")
    assert (ok["relatedType"], ok["relatedId"]) == ("prescription", str(ids["a-related"]))
    failed = items[str(ids["a-failed"])]
    assert failed["errorCode"] == "AE" and "relatedId" not in failed     # not a UUID: left out
    body = found.text
    assert "free text" not in body and "payload" not in body
    only = client("adm").get(f"{API_PREFIX}/admin/integration-messages",
                             params={"status": "failed"}).json()["items"]
    assert [m["id"] for m in only] == [str(ids["a-failed"])]
    assert client("adm").get(f"{API_PREFIX}/admin/integration-messages",
                             params={"partner": "mail"}).status_code == 422
    assert client("md").get(f"{API_PREFIX}/admin/integration-messages").json()["code"] == (
        "permission-denied")


# -------------------------------------------------------------------- getPatientFhirRecord
def test_a_patients_record_as_fhir(client: Any, practice: Practice) -> None:
    patient = practice.patients["kaia"]
    found = client("md").get(f"{API_PREFIX}/patients/{patient}/fhir-record")
    assert found.status_code == 200, found.text
    bundle = found.json()
    assert (bundle["resourceType"], bundle["type"]) == ("Bundle", "collection")
    (entry,) = [e for e in bundle["entry"] if e["resource"]["resourceType"] == "Patient"]
    assert entry["resource"]["id"] == str(patient) and entry["fullUrl"] == f"urn:uuid:{patient}"
    only = client("md").get(f"{API_PREFIX}/patients/{patient}/fhir-record",
                            params={"types": "Patient"}).json()
    assert {e["resource"]["resourceType"] for e in only["entry"]} == {"Patient"}
    assert client("md").get(f"{API_PREFIX}/patients/{patient}/fhir-record",
                            params={"types": "Encounter"}).status_code == 422
    restricted = client("md").get(
        f"{API_PREFIX}/patients/{practice.patients['restricted']}/fhir-record")
    assert restricted.json()["code"] == "break-glass-required"
    assert client("md-b").get(f"{API_PREFIX}/patients/{patient}/fhir-record").status_code == 404
    assert client("dsp").get(f"{API_PREFIX}/patients/{patient}/fhir-record").json()["code"] == (
        "permission-denied")
