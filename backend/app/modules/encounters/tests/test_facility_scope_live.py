"""Facility scope of every encounter operation (the visit, vitals, diagnoses, notes, closing),
against the live database (SECURITY_MODEL §5.1, D37): clinicians assigned to facility A1 only
never see, change or act on a visit at facility A2 of the same clinic, or anything of it, nor
anything of clinic B. The same patient has a visit at each facility, each made through the API by
that facility's own staff. One table, every operation the module serves (scheduling's
facility_scope.py runs it). Synthetic data only."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest

from app.core import download_tokens as core_tokens
from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.files.tests.fakes import download_tokens
from app.modules.scheduling.tests.conftest import Practice, make_client
from app.modules.scheduling.tests.facility_scope import (
    API,
    Row,
    appointment_today,
    failures,
    report,
    served_operations,
    staff,
    sweep,
)
from app.modules.scheduling.tests.test_check_in_live import _check_in

from .test_doctor_visit_live import MERGE, _seeded_template, _signed_note
from .test_notes_live import _icd, _terminology
from .test_rooming_live import VITALS

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]


def _visit(client: Any, practice: Practice, *, at_a2: bool, front_desk: str, nurse: str,
           doctor: str, code: str) -> dict[str, Any]:
    """A checked-in visit for Kaia with vitals, a diagnosis, a signed note, a draft note and a
    follow-up request, each written by that facility's own staff."""
    p = practice
    appointment = appointment_today(
        p, "kaia", facility=p.other_facility if at_a2 else p.facility,
        provider=p.other_provider if at_a2 else p.provider, hour=14 if at_a2 else 11,
        room=None if at_a2 else p.room)
    done = _check_in(client, appointment, user=front_desk, selfPay=True)
    assert done.status_code == 200, done.text
    encounter: str = done.json()["encounterId"]
    path = f"{API}/encounters/{encounter}"
    vitals = client(nurse).post(f"{path}/vitals", json=VITALS)
    assert vitals.status_code == 201, vitals.text
    diagnosis = client(doctor).post(f"{path}/diagnoses", json=_icd(code))
    assert diagnosis.status_code == 201, diagnosis.text
    signed = _signed_note(client, p, encounter, user=doctor)
    draft = client(doctor).post(f"{path}/notes", json={"templateId": _seeded_template(p)})
    assert draft.status_code == 201, draft.text
    tag = client(doctor).get(path).headers["ETag"]
    follow_up = client(doctor).put(f"{path}/follow-up", headers={"If-Match": tag},
                                   json={"interval": {"value": 2, "unit": "week"}})
    assert follow_up.status_code == 200, follow_up.text
    workspace = client(doctor).get(path)
    return {"encounter": encounter, "etag": workspace.headers["ETag"],
            "vitals": [v["id"] for v in vitals.json()["vitals"]],
            "diagnosis": diagnosis.json()["id"], "signed": signed["id"],
            "signed_etag": signed["etag"], "draft": draft.json()["id"],
            "draft_etag": draft.headers["ETag"]}


def _calls(user: str, nurse: str, desk: str, v: dict[str, Any], template: str, patient: UUID,
           mine: dict[str, Any] | None = None) -> list[Row]:
    """Every by-ID operation on visit ``v`` of ``patient``, each expected to be 404 for
    ``user`` (``nurse`` and ``desk`` for the operations only their roles hold)."""
    enc = f"{API}/encounters/{v['encounter']}"
    draft, signed = f"{API}/notes/{v['draft']}", f"{API}/notes/{v['signed']}"
    rows = [
        Row("getEncounter", user, "GET", enc, 404),
        Row("updateEncounter", user, "PATCH", enc, 404, json={"reasons": [{"text": "x"}]},
            headers={"If-Match": v["etag"], **MERGE}),
        Row("recordVitals", nurse, "POST", f"{enc}/vitals", 404, json=VITALS),
        Row("markVitalEnteredInError", user, "POST",
            f"{API}/patients/{patient}/vitals/{v['vitals'][0]}/entered-in-error", 404,
            json={"reason": "Wrong chart."}),
        Row("addEncounterDiagnosis", user, "POST", f"{enc}/diagnoses", 404,
            json=_icd("J06.9")),
        Row("removeEncounterDiagnosis", user, "POST",
            f"{enc}/diagnoses/{v['diagnosis']}/remove", 404, json={"reason": "Not mine."}),
        Row("createNote", user, "POST", f"{enc}/notes", 404, json={"templateId": template}),
        Row("listEncounterNotes", user, "GET", f"{enc}/notes", 404),
        Row("getNote", user, "GET", draft, 404),
        Row("getNote", user, "GET", signed, 404),
        Row("updateNoteDraft", user, "PATCH", draft, 404, json={"title": "x"},
            headers={"If-Match": v["draft_etag"], **MERGE}),
        Row("signNote", user, "POST", f"{draft}/sign", 404,
            headers={"If-Match": v["draft_etag"]}),
        Row("addNoteAddendum", user, "POST", f"{signed}/addenda", 404, json={"text": "x"},
            headers={"If-Match": v["signed_etag"]}),
        Row("cosignNote", user, "POST", f"{signed}/cosign", 404, json={"decision": "cosign"},
            headers={"If-Match": v["signed_etag"]}),
        Row("markNoteEnteredInError", user, "POST", f"{draft}/entered-in-error", 404,
            json={"reason": "Wrong chart."}),
        Row("markNoteEnteredInError", user, "POST", f"{signed}/entered-in-error", 404,
            json={"reason": "Wrong chart."}),
        Row("listNoteVersions", user, "GET", f"{signed}/versions", 404),
        Row("closeEncounter", user, "POST", f"{enc}/close", 404),
        Row("setFollowUpRequest", user, "PUT", f"{enc}/follow-up", 404,
            json={"interval": {"value": 1, "unit": "month"}}, headers={"If-Match": v["etag"]}),
        Row("withdrawFollowUpRequest", user, "POST", f"{enc}/follow-up/withdraw", 404,
            json={"reason": "x"}, headers={"If-Match": v["etag"]}),
        Row("declineFollowUpRequest", desk, "POST", f"{enc}/follow-up/decline", 404,
            json={"reason": "x"},
            headers={"If-Match": v["etag"], "Idempotency-Key": str(uuid.uuid4())}),
        Row("createAfterVisitSummary", user, "POST", f"{enc}/after-visit-summary", 404,
            headers={"Idempotency-Key": str(uuid.uuid4())}),
        Row("getAfterVisitSummaryDownloadUrl", desk, "GET",
            f"{enc}/after-visit-summary/download-url", 404),
    ]
    if mine is not None:  # the other visit's diagnosis through the user's own encounter
        rows.append(Row("removeEncounterDiagnosis", user, "POST",
                        f"{API}/encounters/{mine['encounter']}/diagnoses/{v['diagnosis']}"
                        "/remove", 404, json={"reason": "Not mine."},
                        note="own encounter, the other visit's diagnosis"))
    return rows


def _rows(client: Any, practice: Practice, users: dict[str, CurrentUser]) -> list[Row]:
    p = practice
    _terminology(p)
    template = _seeded_template(p)
    staff(p, users, "fd-a2", "fd", facility=p.other_facility)
    staff(p, users, "ma-a2", "ma", facility=p.other_facility)
    staff(p, users, "md-a2", "md", facility=p.other_facility,
          practitioner=("Achterberg29", "Linnea415"))
    mine = _visit(client, p, at_a2=False, front_desk="fd", nurse="ma", doctor="md", code="I10")
    theirs = _visit(client, p, at_a2=True, front_desk="fd-a2", nurse="ma-a2", doctor="md-a2",
                    code="E11.9")
    hidden = (theirs["encounter"], *theirs["vitals"], theirs["diagnosis"], theirs["signed"],
              theirs["draft"], str(p.other_facility))
    kaia = p.patients["kaia"]
    return [
        # --- lists: the patient's visits and vitals keep to A1
        Row("listPatientEncounters", "md", "GET", f"{API}/patients/{kaia}/encounters", 200,
            hidden=hidden, shown=(mine["encounter"],)),
        Row("listPatientEncounters", "md", "GET", f"{API}/patients/{kaia}/encounters", 200,
            params={"status": "in-progress"}, hidden=hidden, shown=(mine["encounter"],)),
        Row("listPatientVitals", "ma", "GET", f"{API}/patients/{kaia}/vitals", 200,
            hidden=hidden, shown=tuple(mine["vitals"])),
        Row("listPatientVitals", "ma", "GET", f"{API}/patients/{kaia}/vitals", 200,
            params={"includeEnteredInError": "true"}, hidden=hidden,
            shown=tuple(mine["vitals"])),
        # --- A1's own workspace shows nothing of the A2 visit
        Row("getEncounter", "md", "GET", f"{API}/encounters/{mine['encounter']}", 200,
            hidden=hidden, shown=(mine["diagnosis"], mine["signed"], *mine["vitals"])),
        Row("listEncounterNotes", "md", "GET", f"{API}/encounters/{mine['encounter']}/notes",
            200, hidden=hidden, shown=(mine["signed"], mine["draft"])),
        # --- every by-ID operation on the A2 visit: 404, nothing changes
        *_calls("md", "ma", "fd", theirs, template, kaia, mine),
        # --- clinic B: clinic A's visit and patient are 404 (RLS)
        Row("listPatientEncounters", "md-b", "GET", f"{API}/patients/{kaia}/encounters", 404),
        Row("listPatientVitals", "md-b", "GET", f"{API}/patients/{kaia}/vitals", 404),
        # Favorites are the user's own settings, no patient or facility: clinic B's doctor
        # reads only their own (empty) list, and can't pick clinic A's template (422).
        Row("getMyFavorites", "md-b", "GET", f"{API}/me/favorites", 200,
            hidden=(template,), note="personal settings: no facility scope"),
        Row("replaceMyFavorites", "md-b", "PUT", f"{API}/me/favorites", 422,
            json={"favorites": [{"kind": "note-template", "targetId": template}]},
            headers={"If-Match": '"stale"'}, note="clinic A's template isn't clinic B's to pick"),
        *_calls("md-b", "md-b", "fd-b", mine, template, kaia),
    ]


@pytest.fixture
def swept(users: dict[str, CurrentUser]) -> Iterator[Any]:
    """The live client with the files module's test download tokens (no token secret here),
    so the summary's download link reaches its chart check."""
    tokens = download_tokens()
    yield from make_client(users, pending=False,
                           overrides={core_tokens.download_tokens: lambda: tokens})


def test_every_encounter_operation_keeps_to_the_users_facilities(
        swept: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    client = swept
    outcomes = sweep(client, practice, _rows(client, practice, users))
    assert not failures(outcomes), report(failures(outcomes))
    assert {o.row.operation for o in outcomes} == served_operations("encounters"), \
        "the table must cover every operation encounters serves"
