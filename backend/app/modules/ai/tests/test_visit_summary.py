"""The visit summary's rules without a database (D119): the visit's lines apart from the chart's,
no IDs sent, every statement cites a line it was given, the switch first, requester-only reads,
never decided as a suggestion. Synthetic data only."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.deps import DEV_USERS, CurrentUser
from app.core.errors import Conflict, NotFound
from app.db.models.enums import AIFeature
from app.modules.ai import differentials as ddx
from app.modules.ai import drafts
from app.modules.ai import visit_summaries as vs
from app.modules.ai.repository import SuggestionRecord
from app.modules.ai.schemas import AiSuggestionDecision, SourceRef, VisitSummaryCreate
from app.modules.ai.summary import ChartLine, SummaryChart

from .fakes import FakeAIRepository

REASON, TEMP, LISIN = uuid4(), uuid4(), uuid4()


def _visit_chart() -> ddx.VisitChart:
    reason = ChartLine("Reason for visit: Cough for three days", SourceRef("Encounter", REASON),
                       "Reason for visit")
    temp = ChartLine("Vital sign at this visit: body-temperature 98.4 [degF]",
                     SourceRef("Observation", TEMP), "Vital sign")
    med = ChartLine("Medication: Lisinopril 10 MG", SourceRef("MedicationRequest", LISIN),
                    "Medication list")
    return ddx.VisitChart(uuid4(), (reason, temp), SummaryChart(lines=(med,)))


def test_the_visit_lines_come_apart_from_the_chart_and_carry_no_ids() -> None:
    found = _visit_chart()
    system, user = vs.render(found, "41-year-old female")
    assert "summarize one visit" in system["content"]
    assert "never recommend" in system["content"]
    assert "This visit:\nS1: Reason for visit: Cough" in user["content"]
    assert "S2: Vital sign at this visit" in user["content"]
    assert "The chart:\nS3: Medication: Lisinopril" in user["content"]
    assert "41-year-old female" in user["content"]
    for secret in (REASON, TEMP, LISIN, found.patient_id):
        assert str(secret) not in user["content"]


def test_a_statement_must_cite_a_line_it_was_given() -> None:
    lines = ddx.lines_of(_visit_chart())
    kept = vs.keep({"statements": [
        {"text": "Seen for a cough of three days.", "sources": ["S1"]},
        {"text": "Afebrile; takes lisinopril.", "sources": ["S2", "S3", "S2"]},
        {"text": "Chest X-ray was clear.", "sources": []},           # cites nothing
        {"text": "Out of range.", "sources": ["S9"]}],                 # no such line
        "insufficientEvidence": False}, lines)
    assert kept is not None
    statements, insufficient = kept
    assert [s["text"] for s in statements] == ["Seen for a cough of three days.",
                                               "Afebrile; takes lisinopril."]
    assert [s["sequence"] for s in statements] == [1, 2]
    assert [link["resourceType"] for link in statements[1]["sources"]] == [
        "Observation", "MedicationRequest"]
    assert statements[0]["sources"][0]["resourceId"] == str(REASON)
    assert not insufficient
    assert vs.keep({"statements": [], "insufficientEvidence": True}, lines) == ([], True)
    only_uncited = vs.keep({"statements": [{"text": "Invented.", "sources": []}],
                            "insufficientEvidence": False}, lines)
    assert only_uncited == ([], True)
    assert vs.keep("not json", lines) is None


async def test_with_the_switch_off_the_visit_is_never_read() -> None:
    async def never(*_: Any) -> ddx.VisitChart:
        raise AssertionError("the visit must not be read")

    repo = FakeAIRepository(clinic_on=False)
    with pytest.raises(Conflict):
        await vs.create(None, repo, None, never,  # type: ignore[arg-type]
                        DEV_USERS["md"], VisitSummaryCreate(encounter_id=uuid4()),
                        lambda ids: None)


async def _stored(repo: FakeAIRepository, requester: CurrentUser) -> UUID:
    stored = await repo.record_suggestion(None, SuggestionRecord(  # type: ignore[arg-type]
        request_id=uuid4(), feature=AIFeature.CHART_SUMMARY, patient_id=uuid4(),
        encounter_id=uuid4(), target_resource_type=vs.VISIT_SUMMARY,
        content={"statements": [], "insufficientEvidence": True}, confidence="low",
        rationale="r", unknowns=()))
    repo.requested_by[stored] = requester.id
    return stored


async def test_a_visit_summary_is_its_requesters_only_and_never_decided() -> None:
    repo = FakeAIRepository()
    summary_id = await _stored(repo, DEV_USERS["md"])

    async def check(*_: Any) -> None:
        return None

    mine = await vs.get(None, repo, check, DEV_USERS["md"], summary_id)  # type: ignore[arg-type]
    assert mine.ai_generated is True and mine.insufficient_evidence is True
    assert mine.statements == []
    with pytest.raises(NotFound):
        await vs.get(None, repo, check, DEV_USERS["app"], summary_id)  # type: ignore[arg-type]
    with pytest.raises(NotFound):
        await vs.get(None, repo, check, DEV_USERS["md"], uuid4())  # type: ignore[arg-type]
    with pytest.raises(NotFound):
        await drafts.decide(None, repo, None, check, DEV_USERS["md"],  # type: ignore[arg-type]
                            summary_id, AiSuggestionDecision(decision="accepted"),
                            lambda patient: None)
