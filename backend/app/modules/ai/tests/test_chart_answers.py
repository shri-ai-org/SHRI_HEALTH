"""Chart Q&A rules without a database: the cached chart block, citations required, "not in the
chart", the front desk's scheduling-only lines and suggested questions. Synthetic data only."""

from __future__ import annotations

import datetime as dt
from types import SimpleNamespace
from uuid import uuid4

from app.core.deps import DEV_USERS
from app.modules.ai import chart_answers as qa
from app.modules.ai.schemas import SourceRef
from app.modules.ai.summary import ChartLine, SummaryChart

PEANUT, LISIN = uuid4(), uuid4()
CHART = SummaryChart(lines=(
    ChartLine("Allergy: Peanuts (high criticality)", SourceRef("AllergyIntolerance", PEANUT),
              "Allergy"),
    ChartLine("Medication: Lisinopril 10 MG, once daily", SourceRef("MedicationRequest", LISIN),
              "Medication list")))


def _request(**kw: object) -> qa.QuestionRequest:
    values: dict[str, object] = {
        "patient_id": uuid4(), "encounter_id": None, "page_type": "consultation",
        "question": "Any drug allergies?", "patient_context": "58-year-old female",
        "chart": CHART, "scheduling_only": False}
    return qa.QuestionRequest(**(values | kw))  # type: ignore[arg-type]


def test_the_chart_block_is_cached_and_the_question_comes_last() -> None:
    system, chart, question = qa.render(_request())
    assert system["role"] == "system" and "Answer only from those lines" in system["content"]
    assert chart[qa.CACHE] == "ephemeral" and "S1: Allergy: Peanuts" in chart["content"]
    assert qa.CACHE not in question and question["content"].endswith("Any drug allergies?")
    assert str(PEANUT) not in chart["content"] + question["content"]


def test_a_statement_must_cite_a_line_it_was_given() -> None:
    kept = qa.keep({"statements": [
        {"text": "Peanut allergy, high criticality.", "sources": ["S1"]},
        {"text": "Allergic to penicillin.", "sources": []},
        {"text": "Allergic to latex.", "sources": ["S7"]}], "insufficientEvidence": False}, CHART)
    assert kept is not None
    assert [s["text"] for s in kept.statements] == ["Peanut allergy, high criticality."]
    assert kept.statements[0]["sources"][0]["resourceId"] == str(PEANUT)
    assert kept.dropped == ["/statements/1", "/statements/2"] and not kept.insufficient


def test_no_supported_statement_means_not_in_the_chart() -> None:
    kept = qa.keep({"statements": [{"text": "Diabetic.", "sources": []}],
                    "insufficientEvidence": False}, CHART)
    assert kept is not None and kept.statements == [] and kept.insufficient
    assert qa.keep("not json at all", CHART) is None


def test_the_front_desk_gets_scheduling_lines_and_questions_only() -> None:
    fd, md = DEV_USERS["fd"], DEV_USERS["md"]
    assert not qa.clinical(fd) and qa.clinical(md)
    assert qa.suggested(fd, "consultation").questions == list(qa.SCHEDULING_QUESTIONS)
    assert qa.suggested(md, "prescribing").questions == list(qa.SUGGESTED["prescribing"])
    for page in qa.PAGE_TYPES:
        assert 1 <= len(qa.suggested(md, page).questions) <= 10
    when = dt.datetime(2026, 11, 24, 15, 0, tzinfo=dt.UTC)
    visit = SimpleNamespace(id=uuid4(), start_at=when, status="booked",
                            appointment_type=SimpleNamespace(name="Follow-up"),
                            provider=SimpleNamespace(display_name="Dr. Sorensen77"),
                            reason_for_visit="Chest pain")
    [line] = qa.schedule_lines([visit])
    assert line.text == "Appointment: 2026-11-24 15:00 UTC, Follow-up, with Dr. Sorensen77, booked"
    assert "Chest pain" not in line.text and line.source.resource_type == "Appointment"
