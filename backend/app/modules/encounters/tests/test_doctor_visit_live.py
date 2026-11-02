"""The doctor's part of one visit, end to end, through the real API on a live database (demo steps
7 and 8, D108): check-in, the encounter read, the reasons edited with If-Match, diagnoses added
and one removed before signing (D24), a note from the seeded follow-up template, autosaved with
If-Match, signed and then locked (D8), amended, co-signed by the named co-signer only (D73), and
the visit closed with its guards (Q22 default). Every call goes through core's tenant_db,
facility filter, chart check (D37), audit, events and idempotency, and Anand's helpers, as
shri_app.

Along the way: a restricted chart needs break-glass, and a care-team member passes without it
(D37); another clinic or another facility gets 404 on every step. Uses scheduling's live fixtures
(conftest.py). Synthetic data only; the ICD-10-CM codes are a handful of real public-domain codes
inserted for the test."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from app.core.deps import DEV_USERS, CurrentUser
from app.db.models import MAPPERS
from app.db.seed.starter import NOTE_TEMPLATES
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import Practice, setup_session
from app.modules.scheduling.tests.test_check_in_live import _check_in, _sql, _today_appointment

from .test_notes_live import _icd, _terminology

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
MERGE = {"Content-Type": "application/merge-patch+json"}
AUTHOR = "Dr. Rowan310 Sorensen77"  # the md user's practitioner (scheduling's conftest)
SUPERVISOR = ("Halvorsen61", "Quinn402")
COLLEAGUE = ("Achterberg29", "Linnea415")


# ------------------------------------------------------------------------------------ set-up
def _seeded_template(practice: Practice) -> str:
    """The demo seed's follow-up template (app.db.seed.starter, FOLLOW-UP), in the test clinic."""
    code, name, loinc, sections = next(t for t in NOTE_TEMPLATES if t[0] == "FOLLOW-UP")
    seeded = _sql(practice, "SELECT id FROM admin.note_template WHERE tenant_id = :t "
                  "AND code = :c", t=practice.clinic, c=code)
    if seeded:
        return str(seeded[0][0])
    template = uuid.uuid4()
    _sql(practice, "INSERT INTO admin.note_template (id, tenant_id, code, version, name, "
         "note_type_loinc, is_active) VALUES (:id, :t, :code, 1, :name, :loinc, true)",
         id=template, t=practice.clinic, code=code, name=name, loinc=loinc)
    for seq, (section, title, required) in enumerate(sections, start=1):
        _sql(practice, "INSERT INTO admin.note_template_section (id, tenant_id, template_id, "
             "sequence, section_code, title, is_required) VALUES (gen_random_uuid(), :t, :tpl, "
             ":seq, :code, :title, :req)", t=practice.clinic, tpl=template, seq=seq,
             code=section, title=title, req=required)
    return str(template)


def _doctor(practice: Practice, users: dict[str, CurrentUser], key: str, name: tuple[str, str],
            facility: uuid.UUID | None = None) -> uuid.UUID:
    """Another MD user with a practitioner of its own, signed in as ``key`` at ``facility``
    (default A1). Returns the practitioner."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        doctor = MAPPERS["practitioner"]()
        doctor.name = [MAPPERS["human_name"](family=name[0], given=[name[1]], prefix=["Dr."],
                                             use="official")]
        db.add(doctor)
        db.flush()
        practitioner: uuid.UUID = doctor.id
        made = MAPPERS["app_user"](tenant_id=practice.clinic, keycloak_subject=str(uuid.uuid4()),
                                   username=f"{key}.{uuid.uuid4().hex[:8]}",
                                   display_name=f"Dev MD {key}", practitioner_id=practitioner)
        db.add(made)
        db.flush()
        user_id: uuid.UUID = made.id
        db.commit()
    finally:
        db.close()
        admin.dispose()
    users[key] = CurrentUser(id=user_id, organization_id=practice.clinic,
                             roles=DEV_USERS["md"].roles,
                             facility_ids=frozenset({facility or practice.facility}),
                             display_name=f"Dev MD {key}")
    return practitioner


def _practitioner_of(practice: Practice, user: CurrentUser) -> uuid.UUID:
    found: uuid.UUID = _sql(practice, "SELECT practitioner_id FROM admin.app_user WHERE id = :u",
                            u=user.id)[0][0]
    return found


def _cosign_rule(practice: Practice, supervisee: uuid.UUID, supervisor: uuid.UUID) -> None:
    _sql(practice, "INSERT INTO admin.cosign_rule (id, tenant_id, supervisee_practitioner_id, "
         "supervising_practitioner_id, applies_to_notes, applies_to_prescriptions, "
         "applies_to_orders, effective_from) VALUES (gen_random_uuid(), :t, :a, :s, true, false, "
         "false, current_date - 1)", t=practice.clinic, a=supervisee, s=supervisor)


def _grant(practice: Practice, user: CurrentUser, patient: uuid.UUID) -> None:
    """A current break-glass grant, as the grant endpoint (Thulasi's, D53) writes it."""
    now = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1)
    _sql(practice, "INSERT INTO audit.break_glass_access (id, tenant_id, patient_id, user_id, "
         "reason_code, granted_at, expires_at) VALUES (gen_random_uuid(), :t, :p, :u, "
         "'emergency-care', :g, :e)", t=practice.clinic, p=patient, u=user.id, g=now,
         e=now + dt.timedelta(hours=4))


def _care_team(practice: Practice, user: CurrentUser, patient: uuid.UUID) -> None:
    _sql(practice, "INSERT INTO admin.care_team_member (id, tenant_id, patient_id, user_id, "
         "role_code, period_start) VALUES (gen_random_uuid(), :t, :p, :u, 'PCP', "
         "current_date - 30)", t=practice.clinic, p=patient, u=user.id)


# ---------------------------------------------------------------------------------- the calls
def _code(response: Any) -> str:
    code: str = response.json()["code"]
    return code


def _etag(client: Any, path: str, user: str = "md") -> str:
    found = client(user).get(path)
    assert found.status_code == 200, found.text
    tag: str = found.headers["ETag"]
    return tag


def _sections(note: dict[str, Any], texts: dict[str, str]) -> dict[str, Any]:
    return {"sections": [{"id": s["id"], "text": texts[s["code"]]} for s in note["sections"]
                         if s["code"] in texts]}


def _checked_in(client: Any, practice: Practice, patient: str = "kaia") -> str:
    """Step 1: the front desk checks the patient in; the encounter opens (D16)."""
    appointment = _today_appointment(practice, patient)
    done = _check_in(client, appointment, selfPay=True)
    assert done.status_code == 200, done.text
    encounter: str = done.json()["encounterId"]
    return encounter


def _signed_note(client: Any, practice: Practice, encounter: str, user: str = "md"
                 ) -> dict[str, Any]:
    note = client(user).post(f"{API}/encounters/{encounter}/notes",
                             json={"templateId": _seeded_template(practice)})
    assert note.status_code == 201, note.text
    body = note.json()
    write = client(user).patch(
        f"{API}/notes/{body['id']}",
        json=_sections(body, {"10154-3": "Headache.", "10164-2": "Better with rest.",
                              "29545-1": "Normal exam.", "51847-2": "Tension headache."}),
        headers={"If-Match": note.headers["ETag"], **MERGE})
    assert write.status_code == 200, write.text
    signed = client(user).post(f"{API}/notes/{body['id']}/sign",
                               headers={"If-Match": write.headers["ETag"]})
    assert signed.status_code == 200, signed.text
    result: dict[str, Any] = signed.json()
    result["etag"] = signed.headers["ETag"]
    return result


# ------------------------------------------------------------------------------------- tests
def test_the_doctors_part_of_the_visit(client: Any, practice: Practice,
                                       users: dict[str, CurrentUser]) -> None:
    _terminology(practice)
    supervisor = _doctor(practice, users, "sup", SUPERVISOR)
    _doctor(practice, users, "md2", COLLEAGUE)
    _cosign_rule(practice, _practitioner_of(practice, users["md"]), supervisor)
    patient = str(practice.patients["kaia"])

    # 1. Check-in.
    encounter = _checked_in(client, practice)
    path = f"{API}/encounters/{encounter}"

    # 2. The encounter read: the workspace, audited as a chart read.
    read = client("md").get(path)
    assert read.status_code == 200, read.text
    workspace = read.json()
    assert (workspace["status"], workspace["patientId"]) == ("arrived", patient)
    assert workspace["diagnoses"] == [] and workspace["notes"] == []
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :e AND "
                "action = 'read' AND patient_id = :p", e=encounter, p=patient)[0][0] == 1
    early = client("md").post(f"{path}/close")  # nothing written yet: not started
    assert early.status_code == 409 and early.json()["currentState"] == "arrived"

    # 3. The reasons, with If-Match.
    tag = read.headers["ETag"]
    reasons = {"reasons": [{"text": "Headaches for two weeks, worse in the morning."}]}
    assert client("md").patch(path, json=reasons, headers=MERGE).status_code == 428
    stale = client("md").patch(path, json=reasons, headers={"If-Match": '"999"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == tag
    edited = client("md").patch(path, json=reasons, headers={"If-Match": tag, **MERGE})
    assert edited.status_code == 200, edited.text
    assert edited.json()["reasons"] == [
        {"codings": [], "text": "Headaches for two weeks, worse in the morning."}]
    assert edited.headers["ETag"] != tag
    again = client("md").patch(path, json=reasons, headers={"If-Match": tag, **MERGE})
    assert again.status_code == 412  # the old tag is stale now

    # 4. Diagnoses: two added, one removed before signing (D24), its rank freed.
    dpath = f"{path}/diagnoses"
    first = client("md").post(dpath, json=_icd("I10"))
    assert first.status_code == 201 and first.json()["rank"] == 1, first.text
    wrong = client("md").post(dpath, json={**_icd("E11.9"), "rank": 1})
    assert wrong.status_code == 201 and wrong.json()["rank"] == 1, wrong.text
    assert [(d["code"]["code"], d["rank"]) for d in client("md").get(path).json()["diagnoses"]
            ] == [("E11.9", 1), ("I10", 2)]
    removed = client("md").post(f"{dpath}/{wrong.json()['id']}/remove",
                                json={"reason": "Added to the wrong patient's visit."})
    assert removed.status_code == 200, removed.text
    assert removed.json()["verificationStatus"] == "entered-in-error"
    assert "rank" not in removed.json()
    assert [(d["code"]["code"], d["rank"]) for d in client("md").get(path).json()["diagnoses"]
            ] == [("I10", 1)]
    provenance = _sql(practice, "SELECT activity_code, reason_text FROM clinical.provenance "
                      "WHERE target_id = :c", c=wrong.json()["id"])
    assert [tuple(r) for r in provenance] == [("NULLIFY", "Added to the wrong patient's visit.")]
    assert _sql(practice, "SELECT verification_status FROM clinical.condition WHERE id = :c",
                c=wrong.json()["id"])[0][0] == "entered-in-error"  # kept, never deleted
    second = client("md").post(dpath, json=_icd("J06.9"))
    assert second.status_code == 201 and second.json()["rank"] == 2  # the freed rank reused

    # 5. A note from the seeded follow-up template; the first note starts the visit.
    created = client("md").post(f"{path}/notes", json={"templateId": _seeded_template(practice)})
    assert created.status_code == 201, created.text
    note = created.json()
    npath = f"{API}/notes/{note['id']}"
    assert (note["status"], note["title"]) == ("preliminary", "Follow-up visit")
    assert note["author"]["displayName"] == AUTHOR
    assert [(s["code"], s["required"]) for s in note["sections"]] == [
        ("10154-3", True), ("10164-2", True), ("29545-1", True), ("51847-2", True),
        ("69730-0", False)]
    assert client("md").get(path).json()["status"] == "in-progress"
    draft_open = client("md").post(f"{path}/close")  # a draft and no signed note block closing
    assert draft_open.status_code == 422 and draft_open.json()["errors"] == [
        {"in": "body", "pointer": "/notes", "code": "required"},
        {"in": "body", "pointer": "/notes", "code": "not-allowed-value"}]

    # 6. Autosave with If-Match: missing is 428, stale is 412 (with the current tag).
    first_text = _sections(note, {"10154-3": "Headaches for two weeks."})
    assert client("md").patch(npath, json=first_text, headers=MERGE).status_code == 428
    stale_note = client("md").patch(npath, json=first_text, headers={"If-Match": '"999"', **MERGE})
    assert stale_note.status_code == 412
    assert stale_note.headers["ETag"] == created.headers["ETag"]
    saved = client("md").patch(npath, json=first_text,
                               headers={"If-Match": created.headers["ETag"], **MERGE})
    assert saved.status_code == 200, saved.text
    lost = client("md").patch(npath, json=_sections(note, {"10154-3": "An older tab's text."}),
                              headers={"If-Match": created.headers["ETag"], **MERGE})
    assert lost.status_code == 412  # a second tab can't overwrite the first
    assert client("md").get(npath).json()["sections"][0]["text"] == "Headaches for two weeks."
    refused = client("md").post(f"{npath}/sign", headers={"If-Match": saved.headers["ETag"]})
    assert refused.status_code == 422 and refused.json()["errors"] == [
        {"in": "body", "pointer": f"/sections/{i}/text", "code": "required"} for i in (1, 2, 3)]
    rest = client("md").patch(
        npath, json=_sections(note, {"10164-2": "Better with rest and fluids.",
                                     "29545-1": "Neurologic exam normal.",
                                     "51847-2": "Tension headache. Sleep hygiene."}),
        headers={"If-Match": saved.headers["ETag"], **MERGE})
    assert rest.status_code == 200, rest.text

    # 7. Sign: final, its Provenance, then locked (D8), the diagnoses with it (D24).
    assert client("md").post(f"{npath}/sign").status_code == 428
    signed = client("md").post(f"{npath}/sign", headers={"If-Match": rest.headers["ETag"]})
    assert signed.status_code == 200, signed.text
    s = signed.json()
    assert (s["status"], s["cosignStatus"]) == ("final", "pending")
    assert s["signedBy"]["displayName"] == AUTHOR
    assert s["cosigner"] == {"id": str(supervisor), "displayName": "Dr. Quinn402 Halvorsen61"}
    assert [tuple(r) for r in _sql(practice, "SELECT activity_code FROM clinical.provenance "
                                   "WHERE target_id = :n", n=note["id"])] == [("LA",)]
    locked = client("md").patch(npath, json=first_text,
                                headers={"If-Match": signed.headers["ETag"], **MERGE})
    assert locked.status_code == 409 and _code(locked) == "record-locked"
    late = client("md").post(dpath, json=_icd("E11.9"))
    assert late.status_code == 409 and _code(late) == "record-locked"
    late_remove = client("md").post(f"{dpath}/{second.json()['id']}/remove",
                                    json={"reason": "Too late."})
    assert late_remove.status_code == 409 and _code(late_remove) == "record-locked"
    resigned = client("md").post(f"{npath}/sign", headers={"If-Match": signed.headers["ETag"]})
    assert resigned.status_code == 409 and resigned.json()["currentState"] == "final"

    # 8. An addendum: the note becomes amended, still waiting for its co-signature.
    addendum = {"text": "Home blood pressure log reviewed: within goal."}
    amended = client("md").post(f"{npath}/addenda", json=addendum,
                                headers={"If-Match": signed.headers["ETag"]})
    assert amended.status_code == 200, amended.text
    a = amended.json()
    assert (a["status"], a["cosignStatus"]) == ("amended", "pending")
    assert [x["text"] for x in a["addenda"]] == [addendum["text"]]
    assert client("md").post(f"{npath}/addenda", json=addendum,
                             headers={"If-Match": signed.headers["ETag"]}).status_code == 412

    # 9. Co-sign: the named co-signer only; not the author, not another MD.
    cosign = f"{npath}/cosign"
    for user in ("md", "md2"):
        refused_cosign = client(user).post(cosign, json={"decision": "cosign"},
                                           headers={"If-Match": amended.headers["ETag"]})
        assert refused_cosign.status_code == 403, (user, refused_cosign.text)
        assert _code(refused_cosign) == "permission-denied"
    for user in ("fd", "ma", "rn"):
        assert client(user).post(cosign, json={"decision": "cosign"},
                                 headers={"If-Match": amended.headers["ETag"]}
                                 ).status_code == 403, user
    cosigned = client("sup").post(cosign, json={"decision": "cosign"},
                                  headers={"If-Match": amended.headers["ETag"]})
    assert cosigned.status_code == 200, cosigned.text
    c = cosigned.json()
    assert (c["status"], c["cosignStatus"]) == ("amended", "cosigned")
    assert c["cosignedBy"]["id"] == str(supervisor) and c["cosignedAt"]
    versions = client("md").get(f"{npath}/versions").json()["items"]
    assert [v["status"] for v in versions][:3] == ["amended", "amended", "final"]

    # 10. Close: the guards pass now (a signed note, a live diagnosis, no draft).
    closed = client("md").post(f"{path}/close")
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "finished" and closed.json()["endedAt"]
    assert [d["code"]["code"] for d in closed.json()["diagnoses"]] == ["I10", "J06.9"]
    twice = client("md").post(f"{path}/close")
    assert twice.status_code == 409 and twice.json()["currentState"] == "finished"
    after = client("md").post(f"{path}/notes", json={"templateId": _seeded_template(practice)})
    assert after.status_code == 409 and after.json()["currentState"] == "finished"

    # The events the other modules listen to, each once, in the visit's own transactions.
    events = [t for (t,) in _sql(practice, "SELECT type FROM admin.event_log WHERE subject IN "
                                 "(:e, :n)", e=f"encounter/{encounter}", n=f"note/{note['id']}")]
    for kind in ("note.signed", "note.cosigned", "encounter.closed"):
        assert events.count(kind) == 1, (kind, events)
    # Every write named the patient in the audit trail.
    writes = _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p AND "
                  "action IN ('create', 'update', 'execute')", p=patient)[0][0]
    assert writes >= 10


def test_a_restricted_chart_needs_break_glass_and_the_care_team_passes(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    """D37: the front desk checks in a restricted patient (D107), but the doctor needs a
    break-glass grant for every step; a care-team member co-signs without one; anyone else is
    still refused, and every refusal is audited."""
    _terminology(practice)
    supervisor = _doctor(practice, users, "sup", SUPERVISOR)
    _doctor(practice, users, "md2", COLLEAGUE)
    _cosign_rule(practice, _practitioner_of(practice, users["md"]), supervisor)
    patient = practice.patients["restricted"]
    encounter = _checked_in(client, practice, "restricted")
    path = f"{API}/encounters/{encounter}"

    refusals = (client("md").get(path),
                client("md").patch(path, json={"reasons": [{"text": "x"}]},
                                   headers={"If-Match": '"1"', **MERGE}),
                client("md").post(f"{path}/diagnoses", json=_icd("I10")),
                client("md").post(f"{path}/notes", json={"templateId": str(uuid.uuid4())}),
                client("md").get(f"{path}/notes"),
                client("md").post(f"{path}/close"))
    for refused in refusals:
        assert refused.status_code == 403 and _code(refused) == "break-glass-required", (
            refused.request.method, refused.request.url, refused.text)
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p AND "
                "action = 'access-denied'", p=patient)[0][0] >= len(refusals)
    assert _sql(practice, "SELECT count(*) FROM clinical.condition WHERE encounter_id = :e",
                e=encounter)[0][0] == 0

    # With a grant, the doctor's whole part runs; the reads are audited as ETREAT.
    _grant(practice, users["md"], patient)
    assert client("md").get(path).status_code == 200
    assert client("md").post(f"{path}/diagnoses", json=_icd("I10")).status_code == 201
    note = _signed_note(client, practice, encounter)
    assert note["cosignStatus"] == "pending"
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE patient_id = :p AND "
                "purpose_of_use = 'ETREAT'", p=patient)[0][0] >= 1
    npath = f"{API}/notes/{note['id']}"

    # The co-signer, without a grant and not on the care team, is refused like anyone else.
    before = client("sup").post(f"{npath}/cosign", json={"decision": "cosign"},
                                headers={"If-Match": note["etag"]})
    assert before.status_code == 403 and _code(before) == "break-glass-required"
    # On the care team: no break-glass needed (D37).
    _care_team(practice, users["sup"], patient)
    assert client("sup").get(npath).status_code == 200
    cosigned = client("sup").post(f"{npath}/cosign", json={"decision": "cosign"},
                                  headers={"If-Match": note["etag"]})
    assert cosigned.status_code == 200, cosigned.text
    assert cosigned.json()["cosignStatus"] == "cosigned"
    # Another MD, neither granted nor on the care team, is still refused.
    other = client("md2").get(npath)
    assert other.status_code == 403 and _code(other) == "break-glass-required"
    assert client("md").post(f"{path}/close").status_code == 200


def test_another_clinic_or_facility_finds_nothing(client: Any, practice: Practice,
                                                  users: dict[str, CurrentUser]) -> None:
    """Every step of the doctor's part answers 404 to a doctor of another clinic (md-b) and to
    a doctor of the same clinic who works only at facility A2, and changes nothing."""
    _terminology(practice)
    _doctor(practice, users, "md-a2", COLLEAGUE, facility=practice.other_facility)
    encounter = _checked_in(client, practice)
    path = f"{API}/encounters/{encounter}"
    diagnosis = client("md").post(f"{path}/diagnoses", json=_icd("I10")).json()
    note = _signed_note(client, practice, encounter)
    npath = f"{API}/notes/{note['id']}"
    tag = {"If-Match": note["etag"]}
    before = _sql(practice, "SELECT meta_version_id FROM clinical.encounter WHERE id = :e",
                  e=encounter)[0][0]
    for user in ("md-b", "md-a2"):
        calls = {
            "getEncounter": client(user).get(path),
            "updateEncounter": client(user).patch(path, json={"reasons": [{"text": "x"}]},
                                                  headers={**tag, **MERGE}),
            "addEncounterDiagnosis": client(user).post(f"{path}/diagnoses", json=_icd("J06.9")),
            "removeEncounterDiagnosis": client(user).post(
                f"{path}/diagnoses/{diagnosis['id']}/remove", json={"reason": "Not mine."}),
            "createNote": client(user).post(f"{path}/notes",
                                            json={"templateId": str(uuid.uuid4())}),
            "listEncounterNotes": client(user).get(f"{path}/notes"),
            "getNote": client(user).get(npath),
            "updateNoteDraft": client(user).patch(npath, json={"title": "x"},
                                                  headers={**tag, **MERGE}),
            "signNote": client(user).post(f"{npath}/sign", headers=tag),
            "addNoteAddendum": client(user).post(f"{npath}/addenda", json={"text": "x"},
                                                 headers=tag),
            "cosignNote": client(user).post(f"{npath}/cosign", json={"decision": "cosign"},
                                            headers=tag),
            "listNoteVersions": client(user).get(f"{npath}/versions"),
            "closeEncounter": client(user).post(f"{path}/close"),
        }
        for operation, response in calls.items():
            assert response.status_code == 404, (user, operation, response.text)
    assert _sql(practice, "SELECT meta_version_id FROM clinical.encounter WHERE id = :e",
                e=encounter)[0][0] == before
    assert client("md").get(npath).json()["addenda"] == []


def test_a_note_is_marked_entered_in_error(client: Any, practice: Practice,
                                          users: dict[str, CurrentUser]) -> None:
    """markNoteEnteredInError with Anand's helper (D14): a draft by its author only, a signed
    note by its author or another MD; the note is kept, marked, with its Provenance and event,
    and no longer counts as the visit's signed note."""
    _terminology(practice)
    _doctor(practice, users, "md2", COLLEAGUE)
    encounter = _checked_in(client, practice)
    path = f"{API}/encounters/{encounter}"
    assert client("md").post(f"{path}/diagnoses", json=_icd("I10")).status_code == 201
    draft = client("md").post(f"{path}/notes", json={"templateId": _seeded_template(practice)})
    assert draft.status_code == 201, draft.text
    url = f"{API}/notes/{draft.json()['id']}/entered-in-error"
    other = client("md2").post(url, json={"reason": "Not mine to remove."})
    assert other.status_code == 403 and _code(other) == "permission-denied"
    for user in ("fd", "ma", "bil", "none"):
        assert client(user).post(url, json={"reason": "Wrong."}).status_code == 403, user
    assert client("md").post(url, json={"reason": " "}).status_code == 422
    assert client("md-b").post(url, json={"reason": "Wrong."}).status_code == 404
    marked = client("md").post(url, json={"reason": "Started on the wrong visit."})
    assert marked.status_code == 200, marked.text
    assert marked.json()["status"] == "entered-in-error"
    assert [tuple(r) for r in _sql(practice, "SELECT activity_code, reason_text FROM "
                                   "clinical.provenance WHERE target_id = :n",
                                   n=draft.json()["id"])] == [
        ("NULLIFY", "Started on the wrong visit.")]
    again = client("md").post(url, json={"reason": "Again."})
    assert again.status_code == 409 and again.json()["currentState"] == "entered-in-error"

    # A signed note: another MD may mark it; it then stops counting for closing the visit.
    signed = _signed_note(client, practice, encounter)
    marked_signed = client("md2").post(f"{API}/notes/{signed['id']}/entered-in-error",
                                       json={"reason": "Documented on the wrong patient."})
    assert marked_signed.status_code == 200, marked_signed.text
    assert marked_signed.json()["status"] == "entered-in-error"
    assert _sql(practice, "SELECT count(*) FROM clinical.composition WHERE id = :n",
                n=signed["id"])[0][0] == 1  # never deleted
    versions = client("md").get(f"{API}/notes/{signed['id']}/versions").json()["items"]
    assert [v["status"] for v in versions][:2] == ["entered-in-error", "final"]
    workspace = client("md").get(path).json()
    assert {(n["id"], n["status"]) for n in workspace["notes"]} == {
        (draft.json()["id"], "entered-in-error"), (signed["id"], "entered-in-error")}
    refused = client("md").post(f"{path}/close")
    assert refused.status_code == 422 and refused.json()["errors"] == [
        {"in": "body", "pointer": "/notes", "code": "required"}]
    assert _sql(practice, "SELECT count(*) FROM admin.event_log WHERE type = "
                "'note.entered-in-error' AND subject IN (:a, :b)", a=f"note/{draft.json()['id']}",
                b=f"note/{signed['id']}")[0][0] == 2
