"""Co-signature rules (inventory #87-89, #251) against the live database: create, list with
its filters, read, patch with If-Match, every business rule, another clinic's rule, the
permissions and the audit (admin). Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import CurrentUser
from app.db.tests import builders as b
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import Practice, setup_session
from app.modules.scheduling.tests.test_check_in_live import _sql

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/cosign-rules"
MERGE = {"Content-Type": "application/merge-patch+json"}
TODAY = dt.date.today()


def _rule(practice: Practice, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"superviseeProviderId": str(practice.other_provider),
                            "supervisingProviderId": str(practice.provider),
                            "effectiveFrom": TODAY.isoformat()}
    body.update(extra)
    return body


def _codes(response: Any) -> list[tuple[str, str]]:
    return sorted((e["pointer"], e["code"]) for e in response.json()["errors"])


def test_a_rule_is_created_listed_read_and_ended(client: Any, practice: Practice,
                                                 users: dict[str, CurrentUser]) -> None:
    created = client("adm").post(API, json=_rule(practice, state="IL", cosignWithinDays=7),
                                 headers={"Idempotency-Key": str(uuid.uuid4())})
    assert created.status_code == 201, created.text
    rule = created.json()
    assert rule["appliesToNotes"] is True and rule["appliesToPrescriptions"] is False
    assert rule["state"] == "IL" and rule["cosignWithinDays"] == 7
    assert created.headers["Location"] == f"{API}/{rule['id']}"
    path = f"{API}/{rule['id']}"
    got = client("adm").get(path)
    assert got.status_code == 200 and got.json() == rule
    tag = got.headers["ETag"]
    listed = client("adm").get(API, params={"providerId": str(practice.provider)})
    assert [r["id"] for r in listed.json()["items"]] == [rule["id"]]
    assert client("adm").get(API, params={"providerId": str(uuid.uuid4())}).json()["items"] == []
    yesterday = (TODAY - dt.timedelta(days=1)).isoformat()
    assert client("adm").get(API, params={"activeOn": yesterday}).json()["items"] == []
    # PATCH with If-Match: end it today; clear the day limit.
    assert client("adm").patch(path, json={"effectiveTo": TODAY.isoformat()},
                               headers=MERGE).status_code == 428
    stale = client("adm").patch(path, json={"effectiveTo": TODAY.isoformat()},
                                headers={"If-Match": '"stale"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == tag
    ended = client("adm").patch(path, json={"effectiveTo": TODAY.isoformat(),
                                            "cosignWithinDays": None},
                                headers={"If-Match": tag, **MERGE})
    assert ended.status_code == 200, ended.text
    assert ended.json()["effectiveTo"] == TODAY.isoformat()
    assert "cosignWithinDays" not in ended.json() and ended.headers["ETag"] != tag
    assert client("adm").patch(path, json={"superviseeProviderId": str(practice.provider)},
                               headers={"If-Match": ended.headers["ETag"], **MERGE}
                               ).status_code == 422  # the supervisee never changes
    audited = _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE category = 'admin' "
                   "AND actor_user_id = :u", u=users["adm"].id)[0][0]
    assert audited >= 2  # the create and the patch


def test_rules_refuse_what_the_contract_names(client: Any, practice: Practice) -> None:
    same = client("adm").post(API, json=_rule(practice,
                                              supervisingProviderId=str(practice.other_provider)))
    assert same.status_code == 422 and ("/supervisingProviderId", "conflicting-fields") in \
        _codes(same)
    none = client("adm").post(API, json=_rule(practice, appliesToNotes=False))
    assert _codes(none) == [("/appliesToNotes", "required")]
    backwards = client("adm").post(API, json=_rule(
        practice, effectiveTo=(TODAY - dt.timedelta(days=1)).isoformat()))
    assert _codes(backwards) == [("/effectiveTo", "out-of-range")]
    unknown = client("adm").post(API, json=_rule(practice,
                                                 supervisingProviderId=str(uuid.uuid4())))
    assert _codes(unknown) == [("/supervisingProviderId", "invalid-reference")]
    _sql(practice, "UPDATE clinical.practitioner SET active = false WHERE id = :p",
         p=practice.other_provider)
    inactive = client("adm").post(API, json=_rule(practice))
    assert _codes(inactive) == [("/superviseeProviderId", "invalid-reference")]
    _sql(practice, "UPDATE clinical.practitioner SET active = true WHERE id = :p",
         p=practice.other_provider)
    assert client("adm").post(API, json=_rule(practice)).status_code == 201
    overlap = client("adm").post(API, json=_rule(
        practice, effectiveFrom=(TODAY + dt.timedelta(days=10)).isoformat()))
    assert _codes(overlap) == [("/effectiveFrom", "conflicting-fields")]
    other_state = client("adm").post(API, json=_rule(practice, state="WI"))
    assert other_state.status_code == 201  # a state-specific rule doesn't overlap the all-state one
    assert client("adm").post(API, json=_rule(practice, state="il")).status_code == 422
    assert client("adm").post(API, json=_rule(practice, cosignWithinDays=91)).status_code == 422
    assert client("adm").post(API, json={**_rule(practice), "extra": 1}).status_code == 422


def test_rules_need_their_permission_and_stay_in_their_clinic(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    for user in ("fd", "ma", "rn", "md", "bil", "none"):
        assert client(user).get(API).status_code == 403, user
        assert client(user).post(API, json=_rule(practice)).status_code == 403, user
    theirs = uuid.uuid4()
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic_b)
    try:
        nurse = b.practitioner(db, "Halvorsen64", "Rowan900")["practitioner"]
        doctor = b.practitioner(db, "Brennan52", "Sasha900")["practitioner"]
        db.flush()
        if True:  # clinic B's own rule, between clinic B's own practitioners
            db.execute(text(
                "INSERT INTO admin.cosign_rule (id, tenant_id, supervisee_practitioner_id, "
                "supervising_practitioner_id, applies_to_notes, applies_to_prescriptions, "
                "applies_to_orders, effective_from) VALUES (:i, :t, :a, :b, true, false, false, "
                ":f)"),
                {"i": theirs, "t": practice.clinic_b, "a": nurse.id, "b": doctor.id,
                 "f": TODAY})
            db.commit()
    finally:
        db.close()
        admin.dispose()
    assert client("adm").get(f"{API}/{theirs}").status_code == 404  # another clinic's, or none
    assert str(theirs) not in client("adm").get(API).text
    assert client("adm").patch(f"{API}/{theirs}", json={"appliesToOrders": True},
                               headers={"If-Match": '"x"', **MERGE}).status_code == 404
