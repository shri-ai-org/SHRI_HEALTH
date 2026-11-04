"""Facility scope of every patient-history operation (allergies), against the live database
(SECURITY_MODEL §5.1, D37). Allergies are patient-level data: they have no facility, so they
follow §5.1's patient row and are clinic-wide by design, even one recorded at a visit at facility
A2 (the rows say so). What is facility-scoped is the visit an allergy may name: a user at A1
can't link an allergy to A2's visit. Clinic B gets 404 for everything (RLS). One table, every
operation the module serves (scheduling's facility_scope.py runs it). Synthetic data only."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.core.deps import CurrentUser
from app.db.tests.conftest import TEST_DATABASE_URL
from app.modules.scheduling.tests.conftest import Practice
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

from .test_allergies_live import MERGE, PENICILLIN

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

BY_DESIGN = "patient-level, clinic-wide by design (§5.1 patient row)"


def _encounter(client: Any, practice: Practice, *, at_a2: bool, front_desk: str) -> str:
    p = practice
    appointment = appointment_today(
        p, "kaia", facility=p.other_facility if at_a2 else p.facility,
        provider=p.other_provider if at_a2 else p.provider, hour=14 if at_a2 else 11,
        room=None if at_a2 else p.room)
    done = _check_in(client, appointment, user=front_desk, selfPay=True)
    assert done.status_code == 200, done.text
    encounter: str = done.json()["encounterId"]
    return encounter


def _allergy(client: Any, base: str, nurse: str, encounter: str) -> tuple[str, str]:
    made = client(nurse).post(base, json={**PENICILLIN, "encounterId": encounter},
                              headers={"Idempotency-Key": str(uuid.uuid4())})
    assert made.status_code == 201, made.text
    return made.json()["id"], made.headers["ETag"]


def _rows(client: Any, practice: Practice, users: dict[str, CurrentUser]) -> list[Row]:
    p = practice
    staff(p, users, "fd-a2", "fd", facility=p.other_facility)
    staff(p, users, "ma-a2", "ma", facility=p.other_facility)
    base = f"{API}/patients/{p.patients['kaia']}/allergies"
    mine_visit = _encounter(client, p, at_a2=False, front_desk="fd")
    their_visit = _encounter(client, p, at_a2=True, front_desk="fd-a2")
    mine, mine_tag = _allergy(client, base, "ma", mine_visit)
    theirs, their_tag = _allergy(client, base, "ma-a2", their_visit)
    return [
        # --- the allergy list and one allergy: clinic-wide (no facility of their own)
        Row("listAllergies", "ma", "GET", base, 200, shown=(mine, theirs), note=BY_DESIGN),
        Row("getAllergy", "ma", "GET", f"{base}/{theirs}", 200, shown=(their_visit,),
            note=f"{BY_DESIGN}; its encounterId names the A2 visit (an ID only)"),
        # --- linking a new allergy to A2's visit: refused like an unknown visit
        Row("addAllergy", "ma", "POST", base, 422,
            json={**PENICILLIN, "encounterId": their_visit},
            note="A2's visit as encounterId: `invalid-reference`"),
        # --- writes on the allergy recorded at A2: clinic-wide too
        Row("updateAllergy", "ma", "PATCH", f"{base}/{theirs}", 200,
            json={"criticality": "low"}, headers={"If-Match": their_tag, **MERGE},
            writes=True, note=BY_DESIGN),
        Row("markAllergyEnteredInError", "md", "POST", f"{base}/{theirs}/entered-in-error", 200,
            json={"reason": "Recorded twice."}, writes=True, note=BY_DESIGN),
        # --- clinic B: the patient and its allergies are 404 (RLS)
        Row("listAllergies", "md-b", "GET", base, 404),
        Row("addAllergy", "md-b", "POST", base, 404, json=PENICILLIN),
        Row("getAllergy", "md-b", "GET", f"{base}/{mine}", 404),
        Row("updateAllergy", "md-b", "PATCH", f"{base}/{mine}", 404,
            json={"criticality": "low"}, headers={"If-Match": mine_tag, **MERGE}),
        Row("markAllergyEnteredInError", "md-b", "POST", f"{base}/{mine}/entered-in-error", 404,
            json={"reason": "Recorded twice."}),
    ]


def test_every_history_operation_follows_the_patient_and_facility_rules(
        client: Any, practice: Practice, users: dict[str, CurrentUser]) -> None:
    outcomes = sweep(client, practice, _rows(client, practice, users))
    assert not failures(outcomes), report(failures(outcomes))
    assert {o.row.operation for o in outcomes} == served_operations("history"), \
        "the table must cover every operation history serves"
