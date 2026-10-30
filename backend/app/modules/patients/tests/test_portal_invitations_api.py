"""The staff side of the patient portal (B8a, D89; ADR-0013 §3, §4): issue and revoke an
invitation, read the chart's portal account. Against the in-memory fakes (fakes.py,
portal_fakes.py); test_portal_invitations_live.py covers the real database and core.

Until core has the ``portal-invitations:*`` and ``portal-accounts:read`` permissions (T45),
``api.py`` leaves these routes out, so the ``portal_app`` fixture stands in for core's rows: it adds
the three permissions to the catalogue and to the roles T45 proposes (FD and ADM; CO reads), then
mounts the router. The operations are already in the operations map. Synthetic data only.
"""

from __future__ import annotations

import importlib
import logging
import re
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import permissions
from app.core.deps import DEV_USERS
from app.core.routing import API_PREFIX

from .. import access
from .conftest import new_patient
from .fakes import World
from .portal_fakes import Account, FakePortalAccounts, PortalWorld, fake_invitations

#: T45's proposed rows (NOTE_FOR_THULASI): create and revoke for FD and ADM, read also for CO.
GRANTS = {
    "portal-accounts:read": ("FD", "ADM", "CO"),
    "portal-invitations:create": ("FD", "ADM"),
    "portal-invitations:revoke": ("FD", "ADM"),
}
CODE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$")


def grant_portal_permissions(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stands in for core's T45 permission rows."""
    monkeypatch.setattr(permissions, "CATALOGUE", permissions.CATALOGUE | set(GRANTS))
    for permission, roles in GRANTS.items():
        for role in roles:
            monkeypatch.setitem(permissions.ROLE_PERMISSIONS, role,
                                permissions.ROLE_PERMISSIONS[role] | {permission})


def mount_portal_router(app: FastAPI) -> Any:
    module = importlib.import_module("app.modules.patients.portal_api")
    app.include_router(module.router, prefix=API_PREFIX)
    return module


@pytest.fixture
def portal(world: World) -> PortalWorld:
    return PortalWorld(world)


@pytest.fixture
def portal_app(app: FastAPI, portal: PortalWorld,
               monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    grant_portal_permissions(monkeypatch)
    module = mount_portal_router(app)
    app.dependency_overrides[module.portal_accounts] = lambda: FakePortalAccounts(portal)
    app.dependency_overrides[access.portal_invitations] = lambda: fake_invitations(portal)
    yield app


Client = Callable[[str], TestClient]


@pytest.fixture
def staff(portal_app: FastAPI) -> Client:
    def client(name: str) -> TestClient:
        c = TestClient(portal_app, raise_server_exceptions=False)
        c.headers["X-Dev-User"] = name
        return c
    return client


_PEOPLE = iter(range(10, 10_000))


def register(staff: Client) -> UUID:
    """A new synthetic patient, unlike any other (no possible-duplicate)."""
    n = next(_PEOPLE)
    created = staff("fd").post("/api/v1/patients", json=new_patient(
        name={"family": f"Testfamily{n}", "given": [f"Given{n}"]},
        birthDate=f"19{n % 90 + 10:02d}-0{n % 9 + 1}-1{n % 9}",
        phones=[{"number": f"+1217555{n:04d}", "use": "mobile"}]))
    assert created.status_code == 201, created.text
    return UUID(created.json()["id"])


def account(patient_id: UUID) -> str:
    return f"/api/v1/patients/{patient_id}/portal-account"


def invitations(patient_id: UUID) -> str:
    return f"/api/v1/patients/{patient_id}/portal-invitations"


def issue(staff: Client, patient_id: UUID, user: str = "fd") -> dict[str, Any]:
    issued = staff(user).post(invitations(patient_id), json={"idChecked": True})
    assert issued.status_code == 201, issued.text
    body: dict[str, Any] = issued.json()
    return body


def code_of(response: Any) -> str:
    code: str = response.json()["code"]
    return code


def set_account(portal: PortalWorld, patient_id: UUID, status: str) -> None:
    clinic = next(iter(portal.world.patients))
    when = datetime(2026, 11, 3, 20, 12, tzinfo=UTC)
    portal.accounts.setdefault(clinic, {})[patient_id] = Account(
        status=status, enrolled_at=None if status == "pending-setup" else when,
        disabled_at=when if status == "disabled" else None)


# ------------------------------------------------------------------------- createPortalInvitation
def test_issue_shows_the_code_once_with_its_expiry(staff: Client, portal: PortalWorld,
                                                   world: World) -> None:
    patient_id = register(staff)
    response = staff("fd").post(invitations(patient_id), json={"idChecked": True})
    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == {"id", "code", "issuedAt", "expiresAt"}
    assert CODE.match(body["code"]) and body["code"] == portal.issued_codes[-1]
    issued_at = datetime.fromisoformat(body["issuedAt"])
    assert datetime.fromisoformat(body["expiresAt"]) - issued_at == timedelta(hours=72)
    assert response.headers["Location"] == f"/api/v1/patients/{patient_id}/portal-account"
    assert response.headers["Cache-Control"] == "no-store"
    # Audited as a security event with the invitation and its expiry, never the code.
    action, reason = world.details[-1]
    assert action == "create" and reason is not None and body["id"] in reason
    assert body["code"] not in reason and body["code"].replace("-", "") not in reason
    # The stored digest isn't the code, and the account state never shows the code.
    stored = portal.invitations[next(iter(portal.invitations))]
    assert all(body["code"].replace("-", "") not in inv.digest for inv in stored.values())
    state = staff("fd").get(account(patient_id))
    assert state.status_code == 200
    assert state.json() == {"patientId": str(patient_id), "status": "invited", "invitation": {
        "id": body["id"], "status": "active", "issuedAt": body["issuedAt"],
        "expiresAt": body["expiresAt"]}}
    assert body["code"] not in state.text


def test_the_code_is_never_logged(staff: Client, portal: PortalWorld,
                                  caplog: pytest.LogCaptureFixture) -> None:
    patient_id = register(staff)
    with caplog.at_level(logging.DEBUG):
        code = issue(staff, patient_id)["code"]
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert code not in logged and code.replace("-", "") not in logged


def test_a_new_invitation_revokes_the_open_one(staff: Client, portal: PortalWorld) -> None:
    patient_id = register(staff)
    first = issue(staff, patient_id)
    second = issue(staff, patient_id, user="adm")
    assert first["id"] != second["id"] and first["code"] != second["code"]
    clinic = next(iter(portal.invitations))
    assert portal.invitations[clinic][UUID(first["id"])].revoked_at is not None
    assert portal.invitations[clinic][UUID(second["id"])].open
    assert staff("fd").get(account(patient_id)).json()["invitation"]["id"] == second["id"]


@pytest.mark.parametrize("user", ["ma", "md", "bil", "co", "none"])
def test_issue_needs_portal_invitations_create(staff: Client, user: str) -> None:
    patient_id = register(staff)
    refused = staff(user).post(invitations(patient_id), json={"idChecked": True})
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"


def test_issue_needs_a_session(staff: Client) -> None:
    patient_id = register(staff)
    anonymous = staff("fd")
    del anonymous.headers["X-Dev-User"]
    assert anonymous.post(invitations(patient_id), json={"idChecked": True}).status_code == 401


@pytest.mark.parametrize("body", [
    {"idChecked": False}, {}, {"idChecked": "yes"}, {"idChecked": True, "note": "x"}, None])
def test_issue_needs_the_id_check(staff: Client, portal: PortalWorld, body: Any) -> None:
    patient_id = register(staff)
    refused = staff("fd").post(invitations(patient_id), json=body)
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation-failed"
    assert portal.issued_codes == []


def test_issue_refuses_a_bad_patient_id(staff: Client) -> None:
    refused = staff("fd").post("/api/v1/patients/not-a-uuid/portal-invitations",
                               json={"idChecked": True})
    assert refused.status_code == 422 and refused.json()["code"] == "validation-failed"


@pytest.mark.parametrize("status", ["pending-setup", "active", "disabled", "suspended"])
def test_issue_is_refused_while_the_chart_has_an_account(staff: Client, portal: PortalWorld,
                                                         status: str) -> None:
    patient_id = register(staff)
    set_account(portal, patient_id, status)
    refused = staff("fd").post(invitations(patient_id), json={"idChecked": True})
    assert refused.status_code == 409, refused.text
    assert refused.json()["code"] == "invalid-state-transition"
    assert refused.json()["currentState"] == status
    assert portal.issued_codes == []


def test_issue_for_a_merged_chart_is_patient_merged(staff: Client, portal: PortalWorld) -> None:
    merged, surviving = register(staff), register(staff)
    portal.merged_into[merged] = surviving
    refused = staff("fd").post(invitations(merged), json={"idChecked": True})
    assert refused.status_code == 409 and refused.json()["code"] == "patient-merged"
    assert portal.issued_codes == []
    assert CODE.match(issue(staff, surviving)["code"])


def test_issue_for_an_unknown_or_other_clinics_patient_is_404(staff: Client) -> None:
    assert staff("fd").post(invitations(uuid4()), json={"idChecked": True}).status_code == 404
    patient_id = register(staff)
    # md-b is in clinic B; give MD the permission so the check reaches the chart.
    with pytest.MonkeyPatch.context() as m:
        m.setitem(permissions.ROLE_PERMISSIONS, "MD",
                  permissions.ROLE_PERMISSIONS["MD"] | {"portal-invitations:create"})
        other = staff("md-b").post(invitations(patient_id), json={"idChecked": True})
    assert other.status_code == 404 and other.json()["code"] == "not-found"


def test_issue_for_a_restricted_chart_needs_break_glass(staff: Client, world: World) -> None:
    patient_id = register(staff)
    next(iter(world.patients.values()))[patient_id].labels.add("R")
    refused = staff("fd").post(invitations(patient_id), json={"idChecked": True})
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    world.grants.add((DEV_USERS["fd"].id, patient_id))
    assert staff("fd").post(invitations(patient_id), json={"idChecked": True}).status_code == 201


# ------------------------------------------------------------------------- revokePortalInvitation
def test_revoke_then_repeat_changes_nothing(staff: Client, portal: PortalWorld,
                                            world: World) -> None:
    patient_id = register(staff)
    issued = issue(staff, patient_id)
    path = f"{invitations(patient_id)}/{issued['id']}/revoke"
    revoked = staff("fd").post(path)
    assert revoked.status_code == 200, revoked.text
    assert revoked.json() == {"patientId": str(patient_id), "status": "none"}
    assert world.details[-1] == ("update", f"Portal invitation {issued['id']} revoked")
    clinic = next(iter(portal.invitations))
    when = portal.invitations[clinic][UUID(issued["id"])].revoked_at
    again = staff("adm").post(path)
    assert again.status_code == 200 and again.json()["status"] == "none"
    assert portal.invitations[clinic][UUID(issued["id"])].revoked_at == when


def test_revoke_a_used_invitation_is_409(staff: Client, portal: PortalWorld) -> None:
    patient_id = register(staff)
    issued = issue(staff, patient_id)
    clinic = next(iter(portal.invitations))
    portal.invitations[clinic][UUID(issued["id"])].used_at = datetime.now(UTC)
    set_account(portal, patient_id, "pending-setup")
    refused = staff("fd").post(f"{invitations(patient_id)}/{issued['id']}/revoke")
    assert refused.status_code == 409 and refused.json()["code"] == "invalid-state-transition"
    assert refused.json()["currentState"] == "used"


def test_revoke_another_patients_invitation_is_404(staff: Client) -> None:
    mine, theirs = register(staff), register(staff)
    issued = issue(staff, theirs)
    refused = staff("fd").post(f"{invitations(mine)}/{issued['id']}/revoke")
    assert refused.status_code == 404 and refused.json()["code"] == "not-found"
    assert staff("fd").post(f"{invitations(mine)}/{uuid4()}/revoke").status_code == 404


@pytest.mark.parametrize("user", ["ma", "md", "bil", "co", "none"])
def test_revoke_needs_portal_invitations_revoke(staff: Client, user: str) -> None:
    patient_id = register(staff)
    issued = issue(staff, patient_id)
    refused = staff(user).post(f"{invitations(patient_id)}/{issued['id']}/revoke")
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"


def test_revoke_refuses_a_bad_invitation_id(staff: Client) -> None:
    patient_id = register(staff)
    refused = staff("fd").post(f"{invitations(patient_id)}/not-a-uuid/revoke")
    assert refused.status_code == 422 and refused.json()["code"] == "validation-failed"


def test_revoke_on_a_restricted_chart_needs_break_glass(staff: Client, world: World) -> None:
    patient_id = register(staff)
    issued = issue(staff, patient_id)
    next(iter(world.patients.values()))[patient_id].labels.add("V")
    refused = staff("adm").post(f"{invitations(patient_id)}/{issued['id']}/revoke")
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"


# ------------------------------------------------------------------------------- getPortalAccount
def test_account_none_then_each_state(staff: Client, portal: PortalWorld) -> None:
    patient_id = register(staff)
    none = staff("co").get(account(patient_id))
    assert none.status_code == 200, none.text
    assert none.json() == {"patientId": str(patient_id), "status": "none"}
    set_account(portal, patient_id, "pending-setup")
    assert staff("fd").get(account(patient_id)).json() == {
        "patientId": str(patient_id), "status": "pending-setup"}
    set_account(portal, patient_id, "active")
    active = staff("adm").get(account(patient_id)).json()
    assert active["status"] == "active" and "enrolledAt" in active and "disabledAt" not in active
    set_account(portal, patient_id, "disabled")
    disabled = staff("fd").get(account(patient_id)).json()
    assert disabled["status"] == "disabled" and "disabledAt" in disabled
    set_account(portal, patient_id, "suspended")
    assert staff("fd").get(account(patient_id)).json()["status"] == "suspended"


def test_an_expired_invitation_is_not_active(staff: Client, portal: PortalWorld) -> None:
    patient_id = register(staff)
    issued = issue(staff, patient_id)
    clinic = next(iter(portal.invitations))
    portal.invitations[clinic][UUID(issued["id"])].expires_at = (
        datetime.now(UTC) - timedelta(minutes=1))
    assert staff("fd").get(account(patient_id)).json() == {
        "patientId": str(patient_id), "status": "none"}


@pytest.mark.parametrize("user", ["ma", "md", "bil", "none"])
def test_account_needs_portal_accounts_read(staff: Client, user: str) -> None:
    patient_id = register(staff)
    refused = staff(user).get(account(patient_id))
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"


def test_account_refuses_a_bad_patient_id(staff: Client) -> None:
    refused = staff("fd").get("/api/v1/patients/not-a-uuid/portal-account")
    assert refused.status_code == 422 and refused.json()["code"] == "validation-failed"


def test_account_of_an_unknown_patient_is_404(staff: Client) -> None:
    assert staff("fd").get(account(uuid4())).status_code == 404


def test_account_of_a_restricted_chart_needs_break_glass(staff: Client, world: World) -> None:
    patient_id = register(staff)
    next(iter(world.patients.values()))[patient_id].labels.add("R")
    refused = staff("fd").get(account(patient_id))
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
    world.grants.add((DEV_USERS["fd"].id, patient_id))
    assert staff("fd").get(account(patient_id)).status_code == 200


def test_account_of_a_merged_chart_is_still_readable(staff: Client, portal: PortalWorld) -> None:
    merged, surviving = register(staff), register(staff)
    portal.merged_into[merged] = surviving
    set_account(portal, merged, "suspended")
    assert staff("fd").get(account(merged)).json()["status"] == "suspended"


# ------------------------------------------------------------------------------------- mounting
def test_the_routes_stay_out_until_core_has_the_permissions() -> None:
    """Without T45's rows the API must still start, without these routes."""
    from .. import api
    from .contract_routes import all_routes, make_app

    if all(permissions.is_known_permission(p) for p in GRANTS):
        pytest.skip("core has the permissions now: the routes are mounted by api.py")
    assert api.portal_staff_ready() is False
    built = {route.operation_id for _, route in all_routes(make_app())}
    assert not built & {"getPortalAccount", "createPortalInvitation", "revokePortalInvitation"}
