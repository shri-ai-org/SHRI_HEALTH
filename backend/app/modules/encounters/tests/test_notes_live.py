"""The doctor's part of the visit against a live database (demo step 8), as shri_app, with core's
tenant_db, facility filter, chart check, audit, events and idempotency and Anand's helpers running
for real: diagnoses added and removed before signing (D24), a templated note started, autosaved
with If-Match, signed with its Provenance (D8), amended, its versions listed (D73), and the visit
closed with the Q22 default guards. Uses scheduling's live fixtures (conftest.py). Synthetic data
only; the ICD-10-CM codes are a handful of real public-domain codes inserted for the test."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from app.core.deps import CurrentUser
from app.db.models import MAPPERS, systems
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import Practice, setup_session
from app.modules.scheduling.tests.test_check_in_live import _sql

from .test_rooming_live import _visit

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1"
MERGE = {"Content-Type": "application/merge-patch+json"}
CODES = (("I10", "Essential (primary) hypertension", True),
         ("E11.9", "Type 2 diabetes mellitus without complications", True),
         ("E11", "Type 2 diabetes mellitus", False),
         ("J06.9", "Acute upper respiratory infection, unspecified", True))
SECTIONS = (("10154-3", "Chief complaint", "", True),
            ("51847-2", "Assessment and plan", "", True),
            ("69730-0", "Patient instructions", "Return if symptoms worsen.", False))


def _icd(code: str, display: str = "") -> dict[str, Any]:
    return {"code": {"system": systems.ICD10CM, "code": code, "display": display or code}}


def _terminology(practice: Practice) -> None:
    for code, display, billable in CODES:
        _sql(practice, "INSERT INTO admin.concept (id, code_system_id, code, display, "
             "is_billable, is_active) SELECT gen_random_uuid(), s.id, :c, :d, :b, true "
             "FROM admin.code_system s WHERE s.uri = :u "
             "ON CONFLICT (code_system_id, code) DO NOTHING",
             c=code, d=display, b=billable, u=systems.ICD10CM)


def _template(practice: Practice, *, active: bool = True, owner: uuid.UUID | None = None,
              loinc: str = "11506-3") -> str:
    template = uuid.uuid4()
    _sql(practice, "INSERT INTO admin.note_template (id, tenant_id, code, version, name, "
         "note_type_loinc, owner_user_id, is_active) VALUES (:id, :t, :code, 1, :name, :loinc, "
         ":owner, :active)", id=template, t=practice.clinic, code=f"T{template.hex[:8]}",
         name="Follow-up visit (synthetic)", loinc=loinc, owner=owner, active=active)
    for i, (code, title, default, required) in enumerate(SECTIONS, start=1):
        _sql(practice, "INSERT INTO admin.note_template_section (id, tenant_id, template_id, "
             "sequence, section_code, title, default_text, is_required) VALUES "
             "(gen_random_uuid(), :t, :tpl, :seq, :code, :title, :text, :req)",
             t=practice.clinic, tpl=template, seq=i, code=code, title=title,
             text=default or None, req=required)
    return str(template)


def _note(client: Any, encounter: str, user: str = "md", **body: Any) -> Any:
    return client(user).post(f"{API}/encounters/{encounter}/notes", json=body)


def _write(client: Any, note: dict[str, Any], texts: dict[str, str], user: str = "md") -> Any:
    sections = [{"id": s["id"], "text": texts[s["code"]]} for s in note["sections"]
                if s["code"] in texts]
    tag = client(user).get(f"{API}/notes/{note['id']}").headers["ETag"]
    return client(user).patch(f"{API}/notes/{note['id']}", json={"sections": sections},
                              headers={"If-Match": tag, **MERGE})


def _sign(client: Any, note_id: str, user: str = "md") -> Any:
    tag = client(user).get(f"{API}/notes/{note_id}").headers["ETag"]
    return client(user).post(f"{API}/notes/{note_id}/sign", headers={"If-Match": tag})


def _code(response: Any) -> str:
    code: str = response.json()["code"]
    return code


# -------------------------------------------------------------------------------- diagnoses
def test_diagnoses_are_ranked_and_removed_before_signing(client: Any,
                                                         practice: Practice) -> None:
    _terminology(practice)
    encounter = _visit(client, practice)
    path = f"{API}/encounters/{encounter}/diagnoses"
    first = client("md").post(path, json=_icd("I10", "typed by the client"))
    assert first.status_code == 201, first.text
    body = first.json()
    assert body["rank"] == 1 and body["verificationStatus"] == "confirmed"
    assert body["code"] == {"system": systems.ICD10CM, "code": "I10",
                            "display": "Essential (primary) hypertension"}  # the terminology's
    assert body["recordedBy"]["displayName"] == "Dr. Rowan310 Sorensen77"
    assert first.headers["Location"].endswith(f"/diagnoses/{body['id']}")
    assert first.headers["ETag"].startswith('"')
    second = client("md").post(path, json={**_icd("E11.9"), "rank": 1, "onsetDate": "2024-03-01"})
    assert second.status_code == 201, second.text
    assert second.json()["rank"] == 1 and second.json()["onsetDate"] == "2024-03-01"
    workspace = client("md").get(f"{API}/encounters/{encounter}").json()
    assert [(d["code"]["code"], d["rank"]) for d in workspace["diagnoses"]] == [
        ("E11.9", 1), ("I10", 2)]
    # Refusals, each named.
    header = client("md").post(path, json=_icd("E11"))
    assert header.status_code == 422 and header.json()["errors"] == [
        {"in": "body", "pointer": "/code/code", "code": "not-allowed-value"}]
    unknown = client("md").post(path, json=_icd("Z99.999"))
    assert unknown.json()["errors"][0]["code"] == "invalid-reference"
    twice = client("md").post(path, json=_icd("I10"))
    assert twice.json()["errors"][0] == {"in": "body", "pointer": "/code/code",
                                         "code": "conflicting-fields"}
    snomed = client("md").post(path, json={"code": {"system": "http://snomed.info/sct",
                                                    "code": "38341003"}})
    assert snomed.json()["errors"][0]["pointer"] == "/code/system"
    gap = client("md").post(path, json={**_icd("J06.9"), "rank": 5})
    assert gap.status_code == 422 and gap.json()["errors"][0]["pointer"] == "/rank"
    year = client("md").post(path, json={**_icd("J06.9"), "onsetDate": "2019"})
    assert year.status_code == 422 and year.json()["errors"][0]["pointer"] == "/onsetDate"
    assert client("md").post(path, json={"code": {"code": "I10"}}).status_code == 422
    assert client("md").post(path, json={**_icd("J06.9"), "extra": 1}).status_code == 422
    assert client("fd").post(path, json=_icd("J06.9")).status_code == 403
    assert client("none").post(path, json=_icd("J06.9")).status_code == 403
    assert client("md-b").post(path, json=_icd("J06.9")).status_code == 404
    # Remove before signing (D24): entered-in-error with its Provenance, the rank freed.
    removed_id = second.json()["id"]
    remove = f"{path}/{removed_id}/remove"
    assert client("md").post(remove, json={"reason": " "}).status_code == 422
    assert client("md").post(remove, json={}).status_code == 422
    assert client("ma").post(remove, json={"reason": "Wrong visit."}).status_code == 403
    done = client("md").post(remove, json={"reason": "Added to the wrong encounter."})
    assert done.status_code == 200, done.text
    assert done.json()["verificationStatus"] == "entered-in-error"
    assert "rank" not in done.json()
    again = client("md").post(remove, json={"reason": "Again."})
    assert again.status_code == 409 and again.json()["currentState"] == "entered-in-error"
    assert client("md").post(f"{path}/{uuid.uuid4()}/remove",
                             json={"reason": "No such diagnosis."}).status_code == 404
    workspace = client("md").get(f"{API}/encounters/{encounter}").json()
    assert [(d["code"]["code"], d["rank"]) for d in workspace["diagnoses"]] == [("I10", 1)]
    reason = _sql(practice, "SELECT reason_text, activity_code FROM clinical.provenance "
                  "WHERE target_id = :c", c=removed_id)
    assert [tuple(r) for r in reason] == [("Added to the wrong encounter.", "NULLIFY")]
    assert _sql(practice, "SELECT count(*) FROM clinical.condition WHERE id = :c",
                c=removed_id)[0][0] == 1  # never deleted
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :e "
                "AND patient_id = :p AND action = 'create'", e=encounter,
                p=practice.patients["kaia"])[0][0] >= 2


def test_a_restricted_chart_needs_break_glass_for_diagnoses_and_notes(
        client: Any, practice: Practice) -> None:
    _terminology(practice)
    encounter = _visit(client, practice, "restricted")
    added = client("md").post(f"{API}/encounters/{encounter}/diagnoses", json=_icd("I10"))
    assert added.status_code == 403 and _code(added) == "break-glass-required"
    note = _note(client, encounter, templateId=_template(practice))
    assert note.status_code == 403 and _code(note) == "break-glass-required"
    listed = client("md").get(f"{API}/encounters/{encounter}/notes")
    assert listed.status_code == 403
    assert _sql(practice, "SELECT count(*) FROM clinical.composition WHERE encounter_id = :e",
                e=encounter)[0][0] == 0


# ------------------------------------------------------------------------------------ notes
def test_a_templated_note_is_written_signed_and_amended(client: Any, practice: Practice) -> None:
    _terminology(practice)
    encounter = _visit(client, practice)
    template = _template(practice)
    created = _note(client, encounter, templateId=template)
    assert created.status_code == 201, created.text
    note = created.json()
    assert note["status"] == "preliminary" and note["cosignStatus"] == "not-required"
    assert note["title"] == "Follow-up visit (synthetic)" and note["templateId"] == template
    assert note["noteType"]["codings"][0]["code"] == "11506-3"
    assert note["author"]["displayName"] == "Dr. Rowan310 Sorensen77"
    assert [(s["code"], s["required"], s["text"]) for s in note["sections"]] == [
        ("10154-3", True, ""), ("51847-2", True, ""),
        ("69730-0", False, "Return if symptoms worsen.")]  # patient instructions (D73)
    assert note["addenda"] == [] and created.headers["Location"] == f"/api/v1/notes/{note['id']}"
    # The first note starts the visit (DATA_OWNERSHIP §5.2), with its event.
    assert client("md").get(f"{API}/encounters/{encounter}").json()["status"] == "in-progress"
    assert _sql(practice, "SELECT count(*) FROM admin.event_log WHERE subject = :s AND type = "
                "'encounter.status-changed' AND data ->> 'status' = 'in-progress'",
                s=f"encounter/{encounter}")[0][0] == 1
    # Autosave with If-Match; every committed save is a version (D73).
    path = f"{API}/notes/{note['id']}"
    tag = created.headers["ETag"]
    body = {"sections": [{"id": note["sections"][0]["id"], "text": "Headaches for 2 weeks."}]}
    assert client("md").patch(path, json=body, headers=MERGE).status_code == 428
    stale = client("md").patch(path, json=body, headers={"If-Match": '"999"', **MERGE})
    assert stale.status_code == 412 and stale.headers["ETag"] == tag
    saved = client("md").patch(path, json=body, headers={"If-Match": tag, **MERGE})
    assert saved.status_code == 200, saved.text
    assert saved.json()["sections"][0]["text"] == "Headaches for 2 weeks."
    assert saved.headers["ETag"] != tag
    wrong = client("md").patch(path, json={"sections": [{"id": str(uuid.uuid4()), "text": "x"}]},
                               headers={"If-Match": saved.headers["ETag"], **MERGE})
    assert wrong.status_code == 422 and wrong.json()["errors"][0] == {
        "in": "body", "pointer": "/sections/0/id", "code": "invalid-reference"}
    # Sign guards (Q22 default, D73): each empty required section is named.
    refused = client("md").post(f"{path}/sign", headers={"If-Match": saved.headers["ETag"]})
    assert refused.status_code == 422 and refused.json()["errors"] == [
        {"in": "body", "pointer": "/sections/1/text", "code": "required"}]
    assert client("md").post(f"{path}/sign").status_code == 428
    assert _write(client, note, {"51847-2": "Tension headache. Hydration, sleep hygiene."}
                  ).status_code == 200
    diagnosis = client("md").post(f"{API}/encounters/{encounter}/diagnoses", json=_icd("I10"))
    assert diagnosis.status_code == 201
    signed = _sign(client, note["id"])
    assert signed.status_code == 200, signed.text
    s = signed.json()
    assert s["status"] == "final" and s["cosignStatus"] == "not-required"
    assert s["signedBy"]["displayName"] == "Dr. Rowan310 Sorensen77" and s["signedAt"]
    provenance = _sql(practice, "SELECT p.activity_code, g.data_sha256 IS NOT NULL FROM "
                      "clinical.provenance p JOIN clinical.provenance_signature g ON "
                      "g.provenance_id = p.id WHERE p.target_id = :n", n=note["id"])
    assert [tuple(r) for r in provenance] == [("LA", True)]
    assert _sql(practice, "SELECT count(*) FROM admin.event_log WHERE subject = :s AND type = "
                "'note.signed'", s=f"note/{note['id']}")[0][0] == 1
    # Signed: locked (D8), and the encounter's diagnoses with it (D24).
    locked = client("md").patch(path, json=body, headers={"If-Match": signed.headers["ETag"],
                                                          **MERGE})
    assert locked.status_code == 409 and _code(locked) == "record-locked"
    again = client("md").post(f"{path}/sign", headers={"If-Match": signed.headers["ETag"]})
    assert again.status_code == 409 and again.json()["currentState"] == "final"
    late = client("md").post(f"{API}/encounters/{encounter}/diagnoses", json=_icd("J06.9"))
    assert late.status_code == 409 and _code(late) == "record-locked"
    remove = client("md").post(f"{API}/encounters/{encounter}/diagnoses/"
                               f"{diagnosis.json()['id']}/remove", json={"reason": "Late."})
    assert remove.status_code == 409 and _code(remove) == "record-locked"
    # An addendum: a new signed Composition that appends; the note becomes amended.
    addenda = f"{path}/addenda"
    text = {"text": "Blood pressure log reviewed: above goal."}
    assert client("md").post(addenda, json=text).status_code == 428
    assert client("md").post(addenda, json={"text": ""},
                             headers={"If-Match": signed.headers["ETag"]}).status_code == 422
    amended = client("md").post(addenda, json=text, headers={"If-Match": signed.headers["ETag"]})
    assert amended.status_code == 200, amended.text
    a = amended.json()
    assert a["status"] == "amended" and [x["text"] for x in a["addenda"]] == [text["text"]]
    assert a["addenda"][0]["author"]["displayName"] == "Dr. Rowan310 Sorensen77"
    assert client("md").post(addenda, json=text, headers={"If-Match": signed.headers["ETag"]}
                             ).status_code == 412
    # Lists: the addendum is never a note of its own.
    listed = client("md").get(f"{API}/encounters/{encounter}/notes")
    assert listed.status_code == 200
    assert [(n["id"], n["status"]) for n in listed.json()["items"]] == [(note["id"], "amended")]
    workspace = client("md").get(f"{API}/encounters/{encounter}").json()
    assert [n["id"] for n in workspace["notes"]] == [note["id"]]
    assert client("md").get(f"{API}/encounters/{encounter}/notes",
                            params={"status": "preliminary"}).json()["items"] == []
    addendum_id = a["addenda"][0]["id"]
    assert client("md").get(f"{API}/notes/{addendum_id}").status_code == 404
    # Versions, newest first: created, autosaved twice, signed, amended.
    versions = client("md").get(f"{path}/versions")
    assert versions.status_code == 200, versions.text
    items = versions.json()["items"]
    assert [v["status"] for v in items] == ["amended", "final", "preliminary", "preliminary",
                                            "preliminary"]
    assert [v["versionId"] for v in items] == sorted((v["versionId"] for v in items),
                                                    reverse=True)
    assert items[-1]["sections"][0] == {"code": "10154-3", "title": "Chief complaint",
                                        "text": ""}
    assert items[0]["recordedBy"]["displayName"] == "Dr. Rowan310 Sorensen77"
    paged = client("md").get(f"{path}/versions", params={"limit": 2})
    assert len(paged.json()["items"]) == 2 and paged.json()["nextCursor"]
    # BIL reads signed notes only (SECURITY_MODEL §4.3).
    assert client("bil").get(path).status_code == 200
    assert [v["status"] for v in client("bil").get(f"{path}/versions").json()["items"]] == [
        "amended", "final"]
    assert client("fd").get(path).status_code == 403
    assert client("md-b").get(path).status_code == 404
    assert _sql(practice, "SELECT count(*) FROM audit.audit_event WHERE entity_id = :n "
                "AND action = 'read' AND patient_id = :p", n=note["id"],
                p=practice.patients["kaia"])[0][0] >= 1


def test_note_refusals(client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    encounter = _visit(client, practice)
    template = _template(practice)
    assert _note(client, encounter, "fd", templateId=template).status_code == 403
    assert _note(client, encounter, "none", templateId=template).status_code == 403
    assert _note(client, encounter, "md-b", templateId=template).status_code == 404
    neither = _note(client, encounter)
    assert neither.status_code == 422 and neither.json()["errors"][0]["pointer"] == "/templateId"
    assert _note(client, encounter, templateId="nope").status_code == 422
    assert _note(client, encounter, templateId=template, extra=1).status_code == 422
    for other in (_template(practice, active=False),
                  _template(practice, owner=users["rn"].id),  # someone else's personal one
                  str(uuid.uuid4())):
        refused = _note(client, encounter, templateId=other)
        assert refused.status_code == 422 and refused.json()["errors"] == [
            {"in": "body", "pointer": "/templateId", "code": "invalid-reference"}]
    no_loinc = _note(client, encounter, noteType={"codings": [{"system": "urn:x", "code": "y"}]})
    assert no_loinc.status_code == 422
    # A user who is not a practitioner writes no notes.
    nurse_type = {"codings": [{"system": systems.LOINC, "code": "34746-8",
                               "display": "Nurse note"}]}
    assert _note(client, encounter, "rn", noteType=nurse_type).status_code == 403
    nurse = uuid.uuid4()
    _sql(practice, "INSERT INTO clinical.practitioner (id, tenant_id, active) "
         "VALUES (:id, :t, true)", id=nurse, t=practice.clinic)
    _sql(practice, "UPDATE admin.app_user SET practitioner_id = :p WHERE id = :u", p=nurse,
         u=users["rn"].id)
    # RN writes nursing notes only (T42); the author alone edits and signs.
    progress = _note(client, encounter, "rn", templateId=template)
    assert progress.status_code == 403 and _code(progress) == "permission-denied"
    nursing = _note(client, encounter, "rn", noteType=nurse_type)
    assert nursing.status_code == 201, nursing.text
    n = nursing.json()
    assert n["title"] == "Nurse note" and len(n["sections"]) == 1 and n["sections"][0]["required"]
    tag = nursing.headers["ETag"]
    edit = {"sections": [{"id": n["sections"][0]["id"], "text": "Patient resting."}]}
    other = client("md").patch(f"{API}/notes/{n['id']}", json=edit,
                               headers={"If-Match": tag, **MERGE})
    assert other.status_code == 403
    assert client("md").post(f"{API}/notes/{n['id']}/sign",
                             headers={"If-Match": tag}).status_code == 403
    assert _write(client, n, {"34746-8": "Patient resting."}, "rn").status_code == 200
    assert _sign(client, n["id"], "rn").status_code == 200
    # BIL never sees a draft (404, so its existence is not revealed).
    draft = _note(client, encounter, templateId=template).json()
    assert client("bil").get(f"{API}/notes/{draft['id']}").status_code == 404
    assert client("bil").get(f"{API}/notes/{draft['id']}/versions").status_code == 404
    bil_list = client("bil").get(f"{API}/encounters/{encounter}/notes").json()["items"]
    assert [x["id"] for x in bil_list] == [n["id"]]
    assert client("md").get(f"{API}/notes/{uuid.uuid4()}").status_code == 404
    assert client("md").get(f"{API}/notes/nope").status_code == 422


def test_a_cosign_rule_names_the_cosigner(client: Any, practice: Practice,
                                          users: dict[str, CurrentUser]) -> None:
    encounter = _visit(client, practice)
    author = _sql(practice, "SELECT practitioner_id FROM admin.app_user WHERE id = :u",
                  u=users["md"].id)[0][0]
    _sql(practice, "INSERT INTO admin.cosign_rule (id, tenant_id, supervisee_practitioner_id, "
         "supervising_practitioner_id, applies_to_notes, applies_to_prescriptions, "
         "applies_to_orders, effective_from) VALUES (gen_random_uuid(), :t, :a, :s, true, "
         "false, false, current_date - 1)", t=practice.clinic, a=author, s=practice.provider)
    note = _note(client, encounter, noteType={"codings": [{"system": systems.LOINC,
                                                            "code": "11506-3"}]}).json()
    assert note["title"] == "Progress note"
    assert _write(client, note, {"11506-3": "Seen and examined."}).status_code == 200
    signed = _sign(client, note["id"])
    assert signed.status_code == 200, signed.text
    assert signed.json()["cosignStatus"] == "pending"
    assert signed.json()["cosigner"] == {"id": str(practice.provider),
                                         "displayName": "Dr. Avery401 Lindqvist58"}


SUPERVISOR = "Dr. Quinn402 Halvorsen61"


def _supervisor(practice: Practice, users: dict[str, CurrentUser]) -> uuid.UUID:
    """A second MD user, linked to a practitioner of its own (SUPERVISOR), who supervises the
    md user under a co-sign rule for notes. Returns the supervisor's practitioner."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        doctor = MAPPERS["practitioner"]()
        doctor.name = [MAPPERS["human_name"](family="Halvorsen61", given=["Quinn402"],
                                             prefix=["Dr."], use="official")]
        db.add(doctor)
        db.flush()
        supervisor: uuid.UUID = doctor.id
        made = MAPPERS["app_user"](tenant_id=practice.clinic, keycloak_subject=str(uuid.uuid4()),
                                   username=f"sup.{uuid.uuid4().hex[:8]}",
                                   display_name="Dev MD supervisor", practitioner_id=supervisor)
        db.add(made)
        db.flush()
        user: uuid.UUID = made.id
        db.commit()
    finally:
        db.close()
        admin.dispose()
    md = users["md"]
    users["sup"] = CurrentUser(id=user, organization_id=practice.clinic, roles=md.roles,
                               facility_ids=md.facility_ids,
                               display_name="Dev MD supervisor")
    author = _sql(practice, "SELECT practitioner_id FROM admin.app_user WHERE id = :u",
                  u=md.id)[0][0]
    _sql(practice, "INSERT INTO admin.cosign_rule (id, tenant_id, supervisee_practitioner_id, "
         "supervising_practitioner_id, applies_to_notes, applies_to_prescriptions, "
         "applies_to_orders, effective_from) VALUES (gen_random_uuid(), :t, :a, :s, true, "
         "false, false, current_date - 1)", t=practice.clinic, a=author, s=supervisor)
    return supervisor


def _decide(client: Any, note_id: str, body: dict[str, Any], user: str = "sup",
            tag: str | None = None) -> Any:
    tag = tag or client(user).get(f"{API}/notes/{note_id}").headers["ETag"]
    return client(user).post(f"{API}/notes/{note_id}/cosign", json=body,
                             headers={"If-Match": tag})


def test_the_cosigner_returns_then_cosigns(client: Any, practice: Practice,
                                           users: dict[str, CurrentUser]) -> None:
    """cosignNote with Anand's helpers (D73): only the co-signer the rule named decides; a
    return keeps the note signed and frozen, the author's addendum makes it pending again, and
    the co-signature adds the professional attester and its Provenance. Each decision raises
    its event in the same transaction."""
    supervisor = _supervisor(practice, users)
    encounter = _visit(client, practice)
    note = _note(client, encounter, noteType={"codings": [{"system": systems.LOINC,
                                                            "code": "11506-3"}]}).json()
    assert _write(client, note, {"11506-3": "Seen and examined."}).status_code == 200
    signed = _sign(client, note["id"])
    assert signed.json()["cosignStatus"] == "pending", signed.text
    url = f"{API}/notes/{note['id']}/cosign"
    # Refusals: the author (an MD, but not the one named), no notes:cosign, the body, If-Match.
    author = _decide(client, note["id"], {"decision": "cosign"}, user="md")
    assert author.status_code == 403 and _code(author) == "permission-denied"
    for user in ("fd", "rn", "none"):
        refused = client(user).post(url, json={"decision": "cosign"},
                                    headers={"If-Match": '"1"'})
        assert refused.status_code == 403 and _code(refused) == "permission-denied", user
    assert client("md-b").post(url, json={"decision": "cosign"},
                               headers={"If-Match": '"1"'}).status_code == 404
    no_comment = _decide(client, note["id"], {"decision": "return"})
    assert no_comment.status_code == 422 and no_comment.json()["errors"] == [
        {"in": "body", "pointer": "/comment", "code": "required"}]
    assert _decide(client, note["id"], {"decision": "maybe"}).status_code == 422
    assert client("sup").post(url, json={"decision": "cosign"}).status_code == 428
    stale = _decide(client, note["id"], {"decision": "cosign"}, tag='"1"')
    assert stale.status_code == 412
    # Returned to the author: still signed and frozen.
    returned = _decide(client, note["id"], {"decision": "return",
                                            "comment": "Please add the home readings."})
    assert returned.status_code == 200, returned.text
    r = returned.json()
    assert (r["status"], r["cosignStatus"]) == ("final", "returned")
    assert r["cosignReturn"]["comment"] == "Please add the home readings."
    assert r["cosignReturn"]["returnedBy"]["id"] == str(supervisor)
    assert returned.headers["ETag"].startswith('"')
    frozen = client("md").patch(f"{API}/notes/{note['id']}", json={"title": "Changed"},
                                headers={"If-Match": returned.headers["ETag"], **MERGE})
    assert frozen.status_code == 409 and _code(frozen) == "record-locked"
    twice = _decide(client, note["id"], {"decision": "cosign"})
    assert twice.status_code == 409 and twice.json()["currentState"] == "returned"
    # The author answers with an addendum: pending again.
    answer = client("md").post(f"{API}/notes/{note['id']}/addenda",
                               json={"text": "Home readings average 128/82."},
                               headers={"If-Match": returned.headers["ETag"]})
    assert answer.status_code == 200, answer.text
    assert answer.json()["cosignStatus"] == "pending"
    # Co-signed: the professional attester, its Provenance, final.
    done = _decide(client, note["id"], {"decision": "cosign"})
    assert done.status_code == 200, done.text
    d = done.json()
    assert d["cosignStatus"] == "cosigned" and d["status"] == "amended"
    assert d["cosignedBy"] == {"id": str(supervisor), "displayName": SUPERVISOR}
    assert d["cosignedAt"] and "cosignReturn" not in d
    assert _sql(practice, "SELECT count(*) FROM clinical.composition_attester WHERE "
                "composition_id = :n AND mode = 'professional'", n=note["id"])[0][0] == 1
    again = _decide(client, note["id"], {"decision": "return", "comment": "Late."})
    assert again.status_code == 409 and again.json()["currentState"] == "cosigned"
    events = [(t, data) for t, data in _sql(
        practice, "SELECT type, data FROM admin.event_log WHERE subject = :s "
        "ORDER BY created_at, type", s=f"note/{note['id']}")]
    assert ("note.cosign-returned", {"encounterId": encounter}) in events
    assert ("note.cosigned", {"encounterId": encounter}) in events


# ------------------------------------------------------------------------------------ close
def test_closing_the_visit(client: Any, practice: Practice) -> None:
    _terminology(practice)
    encounter = _visit(client, practice)
    close = f"{API}/encounters/{encounter}/close"
    early = client("md").post(close)
    assert early.status_code == 409 and early.json()["currentState"] == "arrived"
    note = _note(client, encounter, templateId=_template(practice)).json()
    refused = client("md").post(close)
    assert refused.status_code == 422 and refused.json()["errors"] == [
        {"in": "body", "pointer": "/notes", "code": "required"},
        {"in": "body", "pointer": "/notes", "code": "not-allowed-value"},
        {"in": "body", "pointer": "/diagnoses", "code": "required"}]
    assert _write(client, note, {"10154-3": "Headache.", "51847-2": "Tension headache."}
                  ).status_code == 200
    assert _sign(client, note["id"]).status_code == 200
    no_diagnosis = client("md").post(close)
    assert no_diagnosis.json()["errors"] == [
        {"in": "body", "pointer": "/diagnoses", "code": "required"}]
    # An open draft blocks closing too.
    assert _note(client, encounter, templateId=_template(practice)).status_code == 201
    assert client("md").post(close).json()["errors"][0]["code"] == "not-allowed-value"
    assert client("fd").post(close).status_code == 403
    assert client("md-b").post(close).status_code == 404


def test_a_visit_is_closed_with_its_event(client: Any, practice: Practice) -> None:
    _terminology(practice)
    fresh = _visit(client, practice, "marcus")
    fresh_note = _note(client, fresh, templateId=_template(practice)).json()
    assert client("md").post(f"{API}/encounters/{fresh}/diagnoses",
                             json=_icd("I10")).status_code == 201
    assert _write(client, fresh_note, {"10154-3": "Cough.", "51847-2": "URI."}
                  ).status_code == 200
    assert _sign(client, fresh_note["id"]).status_code == 200
    closed = client("md").post(f"{API}/encounters/{fresh}/close")
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "finished" and closed.json()["endedAt"]
    assert closed.headers["ETag"].startswith('"')
    events = _sql(practice, "SELECT type, data FROM admin.event_log WHERE subject = :s "
                  "ORDER BY created_at, type", s=f"encounter/{fresh}")
    assert ("encounter.closed", {"patientId": str(practice.patients["marcus"])}) in [
        (t, d) for t, d in events]
    again = client("md").post(f"{API}/encounters/{fresh}/close")
    assert again.status_code == 409 and again.json()["currentState"] == "finished"
    late = _note(client, fresh, templateId=_template(practice))
    assert late.status_code == 409 and late.json()["currentState"] == "finished"
