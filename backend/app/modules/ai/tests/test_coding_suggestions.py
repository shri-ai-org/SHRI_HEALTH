"""ICD-10 coding suggestions' rules without a database (D70, D119): only codes in the ICD-10-CM
table, named as the table names them, each citing a line, never high, never one already on the
visit; the diagnosing permission; requester only; one decision per code; accepting adds the
diagnosis, rejecting doesn't. Synthetic data only."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.deps import DEV_USERS, CurrentUser
from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.db.models.enums import AIDecision
from app.modules.ai import coding_suggestions as cs
from app.modules.ai import differentials as ddx
from app.modules.ai import drafts
from app.modules.ai.schemas import (
    AiSuggestionDecision,
    CodingSuggestionCreate,
    SourceRef,
    SuggestedCodeDecision,
)
from app.modules.ai.stub_model import StubModel
from app.modules.ai.summary import ChartLine, SummaryChart

from .fakes import FakeAIRepository, StubModelClient

REASON, LISIN = uuid4(), uuid4()
TABLE = {"J20.9": cs.Concept("J20.9", "Acute bronchitis, unspecified", True),
         "R05.1": cs.Concept("R05.1", "Acute cough", True),
         "I10": cs.Concept("I10", "Essential (primary) hypertension", True),
         "J20": cs.Concept("J20", "Acute bronchitis", False)}       # a header code


async def lookup(db: Any, code: str) -> cs.Concept | None:
    return TABLE.get(code)


def _visit(existing: frozenset[str] = frozenset()) -> cs.CodingVisit:
    reason = ChartLine("Reason for visit: Cough for three days", SourceRef("Encounter", REASON),
                       "Reason for visit")
    med = ChartLine("Medication: Lisinopril 10 MG", SourceRef("MedicationRequest", LISIN),
                    "Medication list")
    return cs.CodingVisit(ddx.VisitChart(uuid4(), (reason,), SummaryChart(lines=(med,))),
                          existing)


def test_codes_are_normalized_to_the_tables_form() -> None:
    assert cs.normalize("j209") == "J20.9"
    assert cs.normalize(" R05.1 ") == "R05.1"
    assert cs.normalize("I10") == "I10"
    assert cs.normalize("not a code") is None


def test_the_prompt_separates_the_visit_and_carries_no_ids() -> None:
    found = _visit().chart
    system, user = cs.render(found, "41-year-old female")
    assert "ICD-10-CM" in system["content"] and "never higher" in system["content"]
    assert "This visit:\nS1: Reason for visit: Cough" in user["content"]
    assert "The chart:\nS2: Medication: Lisinopril" in user["content"]
    for secret in (REASON, LISIN, found.patient_id):
        assert str(secret) not in user["content"]


async def test_only_cited_billable_table_codes_not_on_the_visit_are_kept() -> None:
    found = _visit(existing=frozenset({"I10"}))
    kept = await cs.keep(None, {"codes": [  # type: ignore[arg-type]
        {"code": "j209", "rationale": "Cough.", "likelihood": "medium", "sources": ["S1"]},
        {"code": "J20.9", "rationale": "Again.", "likelihood": "medium", "sources": ["S1"]},
        {"code": "R05.1", "rationale": "Cough.", "likelihood": "low", "sources": []},
        {"code": "J20", "rationale": "Header.", "likelihood": "low", "sources": ["S1"]},
        {"code": "Z99.999", "rationale": "Invented.", "likelihood": "low", "sources": ["S1"]},
        {"code": "I10", "rationale": "On the visit.", "likelihood": "low", "sources": ["S2"]},
        {"code": "R05.1", "rationale": "High?", "likelihood": "high", "sources": ["S1"]}],
        "insufficientEvidence": False}, ddx.lines_of(found.chart), found.existing, lookup)
    assert kept is not None
    codes, insufficient = kept
    assert [(c["code"], c["display"], c["confidence"]) for c in codes] == [
        ("J20.9", "Acute bronchitis, unspecified", "medium")]
    assert codes[0]["sources"][0]["resourceType"] == "Encounter"
    assert not insufficient
    nothing = await cs.keep(None, {"codes": [], "insufficientEvidence": True},  # type: ignore[arg-type]
                            ddx.lines_of(found.chart), found.existing, lookup)
    assert nothing == ([], True)
    assert await cs.keep(None, "no", (), frozenset(), lookup) is None  # type: ignore[arg-type]


async def _suggested(repo: FakeAIRepository, user: CurrentUser) -> UUID:
    model = StubModelClient(replies=[json.dumps({"codes": [
        {"code": "J20.9", "rationale": "Cough.", "likelihood": "medium", "sources": ["S1"]},
        {"code": "R05.1", "rationale": "Cough.", "likelihood": "low", "sources": ["S1"]}],
        "insufficientEvidence": False})])
    set_id = await cs.suggest(None, repo, model, lookup, uuid4(), _visit())  # type: ignore[arg-type]
    for suggestion_id in repo.suggestions:
        repo.requested_by[suggestion_id] = user.id
    return set_id


async def _ok(*_: Any) -> None:
    return None


class _Session:
    commits = 0

    async def commit(self) -> None:
        self.commits += 1


async def test_a_suggestion_is_stored_with_one_row_per_code_and_read_by_its_requester() -> None:
    repo = FakeAIRepository()
    set_id = await _suggested(repo, DEV_USERS["md"])
    found = await cs.get(None, repo, _ok, DEV_USERS["md"], set_id)  # type: ignore[arg-type]
    assert [(c.code, c.confidence, c.decision) for c in found.codes] == [
        ("J20.9", "medium", "pending"), ("R05.1", "low", "pending")]
    assert found.ai_generated is True and found.insufficient_evidence is False
    with pytest.raises(NotFound):
        await cs.get(None, repo, _ok, DEV_USERS["app"], set_id)  # type: ignore[arg-type]
    # A code is never decided through decideAiSuggestion.
    with pytest.raises(NotFound):
        await drafts.decide(None, repo, None, _ok, DEV_USERS["md"],  # type: ignore[arg-type]
                            found.codes[0].id, AiSuggestionDecision(decision="accepted"),
                            lambda patient: None)


async def test_a_refused_diagnosis_writes_no_link_and_commits_nothing() -> None:
    """The diagnosis service refuses (for example the note is signed): it raises before its one
    commit, so the code's link is never written and nothing is committed here; in the database
    the decision rolls back with it and the code stays pending."""
    repo = FakeAIRepository()
    set_id = await _suggested(repo, DEV_USERS["md"])
    first = (await cs.get(None, repo, _ok, DEV_USERS["md"], set_id)).codes[0]  # type: ignore[arg-type]

    async def refused(db: Any, user: CurrentUser, encounter: UUID, code: str, display: str,
                      name: Any, link: Any) -> UUID:
        raise Conflict(code="invalid-state-transition", currentState="signed")

    session = _Session()
    with pytest.raises(Conflict):
        await cs.decide(session, repo, _ok, refused, DEV_USERS["md"],  # type: ignore[arg-type]
                        set_id, first.id, SuggestedCodeDecision(decision="accepted"),
                        lambda patient: None)
    assert first.id not in repo.targets
    assert session.commits == 0


async def test_accepting_adds_the_diagnosis_and_rejecting_does_not() -> None:
    repo = FakeAIRepository()
    set_id = await _suggested(repo, DEV_USERS["md"])
    first, second = (await cs.get(None, repo, _ok, DEV_USERS["md"], set_id)).codes  # type: ignore[arg-type]
    added: list[tuple[str, str]] = []
    diagnosis = uuid4()

    async def add(db: Any, user: CurrentUser, encounter: UUID, code: str, display: str,
                  name: Any, link: Any) -> UUID:
        added.append((code, display))
        await link(diagnosis)   # the link is written before the service's one commit
        return diagnosis

    session = _Session()
    accepted = await cs.decide(session, repo, _ok, add, DEV_USERS["md"],  # type: ignore[arg-type]
                               set_id, first.id, SuggestedCodeDecision(decision="accepted"),
                               lambda patient: None)
    assert added == [("J20.9", "Acute bronchitis, unspecified")]
    assert accepted.decision == "accepted" and accepted.diagnosis_id == diagnosis
    assert session.commits == 0   # the diagnosis service commits once, decision and link included
    assert repo.decisions[first.id] == AIDecision.ACCEPTED
    with pytest.raises(Conflict):
        await cs.decide(session, repo, _ok, add, DEV_USERS["md"],  # type: ignore[arg-type]
                        set_id, first.id, SuggestedCodeDecision(decision="rejected",
                                                                reason="Wrong."),
                        lambda patient: None)
    rejected = await cs.decide(session, repo, _ok, add, DEV_USERS["md"],  # type: ignore[arg-type]
                               set_id, second.id,
                               SuggestedCodeDecision(decision="rejected", reason="Chronic."),
                               lambda patient: None)
    assert rejected.decision == "rejected" and rejected.diagnosis_id is None
    assert added == [("J20.9", "Acute bronchitis, unspecified")]   # nothing more added


async def test_decision_refusals() -> None:
    repo = FakeAIRepository()
    set_id = await _suggested(repo, DEV_USERS["md"])
    code = (await cs.get(None, repo, _ok, DEV_USERS["md"], set_id)).codes[0]  # type: ignore[arg-type]

    async def never(*_: Any) -> UUID:
        raise AssertionError("nothing may be added")

    def go(user: str, body: SuggestedCodeDecision, code_id: UUID = code.id) -> Any:
        return cs.decide(_Session(), repo, _ok, never, DEV_USERS[user],  # type: ignore[arg-type]
                         set_id, code_id, body, lambda patient: None)

    for role in ("rn", "ma", "fd"):
        with pytest.raises(Forbidden):
            await go(role, SuggestedCodeDecision(decision="accepted"))
    with pytest.raises(ValidationFailed):
        await go("md", SuggestedCodeDecision(decision="rejected"))
    with pytest.raises(ValidationFailed):
        await go("md", SuggestedCodeDecision(decision="accepted", reason="Why not."))
    with pytest.raises(NotFound):
        await go("app", SuggestedCodeDecision(decision="accepted"))     # not the requester
    with pytest.raises(NotFound):
        await go("md", SuggestedCodeDecision(decision="accepted"), uuid4())
    assert repo.decisions == {}


async def test_only_a_clinician_who_diagnoses_asks_and_the_switch_comes_first() -> None:
    async def never(*_: Any) -> cs.CodingVisit:
        raise AssertionError("the visit must not be read")

    for role in ("rn", "ma", "fd"):
        with pytest.raises(Forbidden):
            await cs.create(None, FakeAIRepository(), None, never, lookup,  # type: ignore[arg-type]
                            DEV_USERS[role], CodingSuggestionCreate(encounter_id=uuid4()),
                            lambda ids: None)
    with pytest.raises(Conflict):
        await cs.create(None, FakeAIRepository(clinic_on=False), None,  # type: ignore[arg-type]
                        never, lookup, DEV_USERS["md"],
                        CodingSuggestionCreate(encounter_id=uuid4()), lambda ids: None)


async def test_the_stub_suggests_a_sample_code_in_the_real_shape() -> None:
    found = _visit()
    reply = await StubModel().complete(cs.render(found.chart, None), max_tokens=100,
                                       schema=cs.CODING_SCHEMA)
    kept = await cs.keep(None, json.loads(reply.content),  # type: ignore[arg-type]
                         ddx.lines_of(found.chart), frozenset(), lookup)
    assert kept is not None and [c["code"] for c in kept[0]] == ["I10"]
