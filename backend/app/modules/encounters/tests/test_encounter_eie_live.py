"""markEncounterEnteredInError (inventory #67; D14; DATA_OWNERSHIP §5.2) against the live database:
notes entered in error first, a billed superbill refuses it, ADM only when no note was ever
signed, the Provenance with the reason, the events, the audit row, another clinic, a restricted
chart. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
from app.modules.scheduling.tests.test_check_in_live import _check_in, _sql, _today_appointment

from .test_doctor_visit_live import _seeded_template, _signed_note

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
WRONG = {"reason": "Opened on the wrong patient."}


def _visit(client: Any, practice: Practice, patient: str = "kaia", hour: int = 12) -> str:
    """A checked-in visit today at ``hour``; its encounter."""
    done = _check_in(client, _today_appointment(practice, patient, hour=hour), selfPay=True)
    assert done.status_code == 200, done.text
    encounter: str = done.json()["encounterId"]
    return encounter


def _mark(client: Any, encounter: str, user: str = "md", body: Any = None) -> Any:
    return client(user).post(f"{API}/encounters/{encounter}/entered-in-error",
                             json=WRONG if body is None else body)


def _note_entered_in_error(client: Any, note: str) -> None:
    done = client("md").post(f"{API}/notes/{note}/entered-in-error",
                             json={"reason": "Wrong patient's visit."})
    assert done.status_code == 200, done.text


def _pointers(response: Any) -> list[str]:
    return sorted(e["pointer"] for e in response.json()["errors"])


def test_a_wrong_visit_is_marked_after_its_notes(client: Any, practice: Practice,
                                                 users: dict[str, CurrentUser]) -> None:
    encounter = _visit(client, practice)
    draft = client("md").post(f"{API}/encounters/{encounter}/notes",
                              json={"templateId": _seeded_template(practice)})
    assert draft.status_code == 201, draft.text
    for user in ("fd", "ma", "rn", "none"):
        assert _mark(client, encounter, user).status_code == 403, user
    assert _mark(client, encounter, "md-b").status_code == 404  # another clinic
    assert _mark(client, encounter, body={"reason": " "}).status_code == 422
    assert _mark(client, encounter, body={}).status_code == 422
    refused = _mark(client, encounter)  # a draft note is still live
    assert refused.status_code == 422 and refused.json()["code"] == "business-rule-violation"
    assert _pointers(refused) == ["/notes"]
    _note_entered_in_error(client, draft.json()["id"])
    done = _mark(client, encounter)
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "entered-in-error"
    assert done.headers["ETag"].startswith('"')
    again = _mark(client, encounter)
    assert again.status_code == 409 and again.json()["currentState"] == "entered-in-error"
    reason = _sql(practice, "SELECT reason_text, activity_code FROM clinical.provenance "
                  "WHERE target_id = :e", e=encounter)
    assert [tuple(r) for r in reason] == [("Opened on the wrong patient.", "NULLIFY")]
    events = _sql(practice, "SELECT type FROM admin.event_log WHERE subject = :s ORDER BY "
                  "created_at", s=f"encounter/{encounter}")
    assert "encounter.entered-in-error" in [e[0] for e in events]
    assert _sql(practice, "SELECT count(*) FROM clinical.encounter WHERE id = :e",
                e=encounter)[0][0] == 1  # nothing is deleted
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :e AND "
                "patient_id = :p AND action = 'update'", e=encounter,
                p=practice.patients["kaia"])[0][0] == 1


def test_adm_only_when_no_note_was_ever_signed(client: Any, practice: Practice,
                                               users: dict[str, CurrentUser]) -> None:
    plain = _visit(client, practice)
    done = _mark(client, plain, "adm")  # no note at all
    assert done.status_code == 200, done.text
    signed = _visit(client, practice, "marcus", hour=14)
    note = _signed_note(client, practice, signed)
    _note_entered_in_error(client, note["id"])
    refused = _mark(client, signed, "adm")  # its note was signed once
    assert refused.status_code == 422 and _pointers(refused) == ["/notes"]
    assert _mark(client, signed, "md").status_code == 200  # the clinician may


def test_a_billed_superbill_refuses_it(client: Any, practice: Practice,
                                       users: dict[str, CurrentUser]) -> None:
    encounter = _visit(client, practice)
    practitioner = _sql(practice, "SELECT practitioner_id FROM admin.app_user WHERE id = :u",
                        u=users["md"].id)[0][0]
    _sql(practice, "INSERT INTO admin.superbill (id, tenant_id, encounter_id, patient_id, "
         "rendering_practitioner_id, facility_id, place_of_service_code, status, approved_at, "
         "approved_by_user_id) VALUES (:i, :t, :e, :p, :r, :f, '11', 'billed', :at, :u)",
         i=uuid.uuid4(), t=practice.clinic, e=encounter, p=practice.patients["kaia"],
         r=practitioner, f=practice.facility, at=dt.datetime.now(dt.UTC), u=users["md"].id)
    refused = _mark(client, encounter)
    assert refused.status_code == 422 and _pointers(refused) == ["/superbill"]
    assert client("md").get(f"{API}/encounters/{encounter}").json()["status"] != \
        "entered-in-error"


def test_a_restricted_visit_needs_break_glass(client: Any, practice: Practice) -> None:
    encounter = _visit(client, practice, "restricted")
    refused = _mark(client, encounter)
    assert refused.status_code == 403 and refused.json()["code"] == "break-glass-required"
