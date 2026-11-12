"""Morning brief and differential rules without a database (D116): per-patient handles, citations
required, never another patient's line, restricted charts never read, never ``high``.
Synthetic data only."""

from __future__ import annotations

import datetime as dt
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.core.deps import DEV_USERS, CurrentUser
from app.core.errors import Forbidden
from app.modules.ai import differentials as ddx
from app.modules.ai import morning_briefs as mb
from app.modules.ai.schemas import DifferentialCreate, SourceRef
from app.modules.ai.summary import ChartLine, SummaryChart

from .fakes import FakeAIRepository

PEANUT, LISIN, REASON = uuid4(), uuid4(), uuid4()
AT = dt.datetime(2026, 11, 20, 14, 0, tzinfo=dt.UTC)


def _visit(patient: UUID, minutes: int = 0) -> mb.Visit:
    return mb.Visit(uuid4(), patient, AT + dt.timedelta(minutes=minutes), "Follow-up")


def _chart(*lines: ChartLine) -> mb.Chart:
    return mb.Chart(_visit(uuid4()), "summarized", tuple(lines), "58-year-old female")


ALLERGY = ChartLine("Allergy: Peanuts", SourceRef("AllergyIntolerance", PEANUT), "Allergy")
MED = ChartLine("Medication: Lisinopril 10 MG", SourceRef("MedicationRequest", LISIN),
                "Medication list")


def test_brief_lines_are_numbered_per_patient_without_ids() -> None:
    first, second = _chart(ALLERGY), _chart(MED)
    system, user = mb.render(dt.date(2026, 11, 20), [first, second])
    assert "Use only those lines" in system["content"]
    assert "P1-S1: Allergy: Peanuts" in user["content"]
    assert "P2-S1: Medication: Lisinopril" in user["content"]
    assert "58-year-old female" in user["content"]
    for secret in (PEANUT, LISIN, first.visit.patient_id, first.visit.appointment_id):
        assert str(secret) not in user["content"]


def test_a_brief_statement_must_cite_its_own_patients_lines() -> None:
    sent = [_chart(ALLERGY), _chart(MED)]
    kept = mb.keep({"patients": [
        {"patient": "P1", "statements": [
            {"text": "Peanut allergy.", "sources": ["P1-S1"]},
            {"text": "On lisinopril.", "sources": ["P2-S1"]},     # another patient's line
            {"text": "Diabetic.", "sources": []},
            {"text": "Out of range.", "sources": ["P1-S9"]}]},
        {"patient": "P2", "statements": [{"text": "Lisinopril daily.", "sources": ["P2-S1"]}]},
        {"patient": "P7", "statements": [{"text": "Nobody.", "sources": ["P7-S1"]}]}]}, sent)
    assert kept is not None
    assert [s["text"] for s in kept[1]] == ["Peanut allergy."]
    assert kept[1][0]["sources"][0]["resourceId"] == str(PEANUT)
    assert [s["text"] for s in kept[2]] == ["Lisinopril daily."]
    assert 7 not in kept
    assert mb.keep("not json", sent) is None


async def test_a_restricted_chart_is_never_read_and_each_patient_is_read_once() -> None:
    open_patient, restricted = uuid4(), uuid4()
    read: list[UUID] = []

    async def check(db: Any, user: CurrentUser, patient: UUID) -> None:
        if patient == restricted:
            raise Forbidden(code="break-glass-required")

    async def reader(db: Any, user: CurrentUser, patient: UUID) -> SummaryChart:
        read.append(patient)
        return SummaryChart(lines=(ALLERGY,))

    visits = [_visit(open_patient), _visit(restricted, 30), _visit(open_patient, 60)]
    found = await mb.charts(None, FakeAIRepository(), check, reader,  # type: ignore[arg-type]
                            DEV_USERS["md"], visits)
    assert [c.status for c in found] == ["summarized", "restricted", "summarized"]
    assert read == [open_patient]
    assert found[1].lines == ()


def _visit_chart() -> ddx.VisitChart:
    reason = ChartLine("Reason for visit: Cough for three days", SourceRef("Encounter", REASON),
                       "Reason for visit")
    return ddx.VisitChart(uuid4(), (reason,), SummaryChart(lines=(MED,)))


def test_differential_lines_separate_the_visit_from_the_chart() -> None:
    system, user = ddx.render(_visit_chart(), "58-year-old female")
    assert "never conclude" in system["content"]
    assert "This visit:\nS1: Reason for visit: Cough" in user["content"]
    assert "The chart:\nS2: Medication: Lisinopril" in user["content"]
    assert str(REASON) not in user["content"]


def test_a_candidate_must_cite_a_line_and_is_never_high() -> None:
    lines = ddx.lines_of(_visit_chart())
    kept = ddx.keep({"candidates": [
        {"condition": "Viral bronchitis", "rationale": "Cough.", "likelihood": "medium",
         "sources": ["S1"]},
        {"condition": "ACE-inhibitor cough", "rationale": "On lisinopril.", "likelihood": "low",
         "sources": ["S2"]},
        {"condition": "Pneumonia", "rationale": "Fever.", "likelihood": "medium", "sources": []},
        {"condition": "Asthma", "rationale": "Wheeze.", "likelihood": "high",
         "sources": ["S1"]}], "insufficientEvidence": False}, lines)
    assert kept is not None
    candidates, insufficient = kept
    assert [c["condition"] for c in candidates] == ["Viral bronchitis", "ACE-inhibitor cough"]
    assert [c["confidence"] for c in candidates] == ["medium", "low"]
    assert candidates[1]["sources"][0]["resourceType"] == "MedicationRequest"
    assert not insufficient
    nothing = ddx.keep({"candidates": [], "insufficientEvidence": True}, lines)
    assert nothing == ([], True)
    assert ddx.keep([1, 2], lines) is None


async def test_only_a_clinician_who_diagnoses_asks_for_a_differential() -> None:
    async def never(*_: Any) -> ddx.VisitChart:
        raise AssertionError("the visit must not be read")

    for role in ("rn", "ma", "fd"):
        with pytest.raises(Forbidden):
            await ddx.create(None, FakeAIRepository(), None, never,  # type: ignore[arg-type]
                             DEV_USERS[role], DifferentialCreate(encounter_id=uuid4()),
                             lambda ids: None)
