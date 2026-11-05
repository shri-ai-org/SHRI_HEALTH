"""The current user's favorites (inventory #84-85) against the live database: the whole-list
replace with If-Match, the labels, each kind's target checks (another clinic's, another user's,
unknown, a header code) and the audit (GET none, PUT admin; D73). Personal settings with no
patient data, so there is no chart or facility check to sweep. Synthetic data only."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import CurrentUser
from app.db.models import systems
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import Practice, setup_session
from app.modules.scheduling.tests.test_check_in_live import _sql

from .test_doctor_visit_live import _seeded_template
from .test_notes_live import _terminology

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/me/favorites"


def _in_clinic(clinic: uuid.UUID, sql: str, **params: Any) -> None:
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, clinic)
    try:
        db.execute(text(sql), params)
        db.commit()
    finally:
        db.close()
        admin.dispose()


def _phrase(clinic: uuid.UUID, owner: uuid.UUID | None, abbreviation: str) -> str:
    phrase = uuid.uuid4()
    _in_clinic(clinic, "INSERT INTO admin.smart_phrase (id, tenant_id, owner_user_id, abbreviation,"
               " expansion) VALUES (:i, :t, :o, :a, 'Return if symptoms worsen.')",
               i=phrase, t=clinic, o=owner, a=abbreviation)
    return str(phrase)


def _prescription_favorite(clinic: uuid.UUID) -> str:
    favorite = uuid.uuid4()
    _in_clinic(clinic, "INSERT INTO admin.prescription_favorite (id, tenant_id, name, rxnorm_code,"
               " medication_display, sig_text, refills) VALUES (:i, :t, "
               "'Amoxicillin 500 (practice)', '308191', 'amoxicillin 500 MG Oral Capsule', "
               "'1 capsule three times daily', 0)",
               i=favorite, t=clinic)
    return str(favorite)


def _audited(practice: Practice, user: CurrentUser) -> list[tuple[str, str]]:
    rows: list[Any] = _sql(practice, "SELECT action, category FROM audit.audit_event WHERE "
                           "actor_user_id = :u AND category IN ('admin', 'none') "
                           "ORDER BY recorded_at", u=user.id)
    return [tuple(r) for r in rows]


def test_favorites_are_replaced_whole_with_if_match(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    _terminology(practice)
    template = _seeded_template(practice)
    mine = _phrase(practice.clinic, users["md"].id, ".ret")
    practice_rx = _prescription_favorite(practice.clinic)
    empty = client("md").get(API)
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"favorites": []}
    first = empty.headers["ETag"]
    body = {"favorites": [
        {"kind": "note-template", "targetId": template, "label": "ignored on PUT"},
        {"kind": "diagnosis", "diagnosis": {"system": systems.ICD10CM, "code": "I10"}},
        {"kind": "diagnosis", "diagnosis": {"system": systems.ICD10CM, "code": "E11.9"}},
        {"kind": "phrase", "targetId": mine},
        {"kind": "prescription", "targetId": practice_rx}]}
    assert client("md").put(API, json=body).status_code == 428
    stale = client("md").put(API, json=body, headers={"If-Match": '"0"'})
    assert stale.status_code == 412 and stale.headers["ETag"] == first
    saved = client("md").put(API, json=body, headers={"If-Match": first})
    assert saved.status_code == 200, saved.text
    second = saved.headers["ETag"]
    assert second != first
    shown = saved.json()["favorites"]
    by_kind = {(f["kind"], f.get("targetId") or f["diagnosis"]["code"]): f for f in shown}
    assert by_kind[("note-template", template)]["label"] == "Follow-up visit"
    assert by_kind[("phrase", mine)]["label"] == ".ret"
    assert by_kind[("prescription", practice_rx)]["label"] == "Amoxicillin 500 (practice)"
    assert [f["diagnosis"]["code"] for f in shown if f["kind"] == "diagnosis"] == ["I10", "E11.9"]
    assert by_kind[("diagnosis", "I10")]["label"] == "Essential (primary) hypertension"
    assert saved.json()["updatedAt"]
    again = client("md").get(API)
    assert again.json() == saved.json() and again.headers["ETag"] == second
    # A second tab still holding the first ETag gets 412, not an overwrite.
    old_tab = client("md").put(API, json={"favorites": []}, headers={"If-Match": first})
    assert old_tab.status_code == 412 and old_tab.headers["ETag"] == second
    # Reordering within a kind is kept; the whole list is replaced.
    reordered = client("md").put(API, headers={"If-Match": second}, json={"favorites": [
        {"kind": "diagnosis", "diagnosis": {"system": systems.ICD10CM, "code": "E11.9"}},
        {"kind": "diagnosis", "diagnosis": {"system": systems.ICD10CM, "code": "I10"}}]})
    assert reordered.status_code == 200, reordered.text
    assert [f["diagnosis"]["code"] for f in reordered.json()["favorites"]] == ["E11.9", "I10"]
    # Another user's list is their own.
    assert client("rn").get(API).json() == {"favorites": []}
    # The two saves, as core audits an admin write; the reads and the refusals aren't (D73).
    assert _audited(practice, users["md"]) == [("config-change", "admin")] * 2


def test_favorites_refuse_targets_the_user_cant_pick(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    _terminology(practice)
    theirs = _phrase(practice.clinic, users["rn"].id, ".nurse")  # another user's own phrase
    elsewhere = _phrase(practice.clinic_b, None, ".clinicb")  # another clinic's
    tag = client("md").get(API).headers["ETag"]
    refused = client("md").put(API, headers={"If-Match": tag}, json={"favorites": [
        {"kind": "phrase", "targetId": theirs},
        {"kind": "phrase", "targetId": elsewhere},
        {"kind": "note-template", "targetId": str(uuid.uuid4())},
        {"kind": "order"},
        {"kind": "diagnosis", "diagnosis": {"system": systems.ICD10CM, "code": "E11"}},
        {"kind": "diagnosis", "diagnosis": {"system": systems.ICD10CM, "code": "Z99.999"}},
        {"kind": "diagnosis", "targetId": str(uuid.uuid4()),
         "diagnosis": {"system": systems.ICD10CM, "code": "I10"}},
        {"kind": "diagnosis", "diagnosis": {"system": "http://snomed.info/sct", "code": "1"}},
        {"kind": "diagnosis"}]})
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "business-rule-violation"
    assert sorted((e["pointer"], e["code"]) for e in refused.json()["errors"]) == sorted([
        ("/favorites/0/targetId", "invalid-reference"),
        ("/favorites/1/targetId", "invalid-reference"),
        ("/favorites/2/targetId", "invalid-reference"),
        ("/favorites/3/targetId", "required"),
        ("/favorites/4/diagnosis/code", "not-allowed-value"),  # a header code
        ("/favorites/5/diagnosis/code", "invalid-reference"),
        ("/favorites/6/targetId", "conflicting-fields"),
        ("/favorites/7/diagnosis/system", "not-allowed-value"),
        ("/favorites/8/diagnosis", "required")])
    assert client("md").get(API).headers["ETag"] == tag  # nothing written
    bad_kind = client("md").put(API, headers={"If-Match": tag},
                                json={"favorites": [{"kind": "allergy", "targetId": theirs}]})
    assert bad_kind.status_code == 422
    too_many = client("md").put(API, headers={"If-Match": tag}, json={"favorites": [
        {"kind": "phrase", "targetId": theirs}] * 301})
    assert too_many.status_code == 422


def test_favorites_need_their_permission(client: Any, practice: Practice) -> None:
    for user in ("fd", "ma", "bil", "none"):
        assert client(user).get(API).status_code == 403, user
        assert client(user).put(API, json={"favorites": []},
                                headers={"If-Match": '"x"'}).status_code == 403, user
    assert client("md-b").get(API).json() == {"favorites": []}  # clinic B's own (empty) list
