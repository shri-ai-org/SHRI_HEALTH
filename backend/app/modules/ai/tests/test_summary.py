"""AI-02's rules without a database: the chart lines the model sees, that every statement keeps
a real source and anything unsourced is dropped, the band, and the stub's summary. Synthetic
data only."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

from app.modules.ai import summary
from app.modules.ai.api import _day
from app.modules.ai.schemas import SourceRef
from app.modules.ai.stub_model import StubModel

VISIT, DX, PEANUT = uuid4(), uuid4(), uuid4()
CHART = summary.SummaryChart(lines=(
    summary.ChartLine("Visit: 2026-10-02, Office visit, finished", SourceRef("Encounter", VISIT),
                      "Visit of 2026-10-02"),
    summary.ChartLine("Diagnosis: Essential hypertension (I10), at the visit of 2026-10-02",
                      SourceRef("Condition", DX), "Visit diagnosis"),
    summary.ChartLine("Allergy: Peanuts (high criticality)", SourceRef("AllergyIntolerance",
                                                                       PEANUT), "Allergy")),
    unavailable=("results (not in this build)",), reason_for_visit="Blood pressure follow-up")


def _request() -> summary.SummaryRequest:
    return summary.SummaryRequest(patient_id=uuid4(), encounter_id=None,
                                  patient_context="58-year-old female", chart=CHART)


def test_the_model_sees_numbered_lines_names_only_and_what_is_missing() -> None:
    system, user = summary.render(_request())
    assert "cites the line numbers" in system["content"]
    text = user["content"]
    assert "S1: Visit: 2026-10-02, Office visit, finished" in text
    assert "S3: Allergy: Peanuts (high criticality)" in text
    assert "Reason for this visit: Blood pressure follow-up." in text
    assert "Not available: results (not in this build)." in text
    for record in (VISIT, DX, PEANUT):
        assert str(record) not in text


def test_every_statement_keeps_its_sources_and_unsourced_ones_are_dropped() -> None:
    reply = {"sections": [
        {"topic": "allergies",
         "statements": [{"text": "Peanut allergy, high.", "sources": ["S3"]}]},
        {"topic": "diagnoses", "statements": [
            {"text": "Hypertension since October.", "sources": ["S2", "S1", "S2"]},
            {"text": "Type 2 diabetes.", "sources": []},           # nothing behind it
            {"text": "Asthma.", "sources": ["S9"]}]},              # a line that doesn't exist
        {"topic": "diagnoses", "statements": [{"text": "Again.", "sources": ["S2"]}]}],
        "missing": [{"topic": "results", "description": "No results in this build."}],
        "extra": "dropped"}
    draft = summary.keep(reply, CHART)
    assert draft is not None
    assert [s["topic"] for s in draft.sections] == ["diagnoses", "allergies"]   # topic order
    [hypertension] = draft.sections[0]["statements"]
    assert [link["resourceType"] for link in hypertension["sources"]] == ["Condition", "Encounter"]
    assert hypertension["sources"][0]["resourceId"] == str(DX)
    assert set(draft.dropped) >= {"/sections/1/statements/1", "/sections/1/statements/2",
                                  "/sections/2", "/extra"}
    assert summary.band(draft) == "low"
    content = summary.content(draft, summary.band(draft))
    assert content["sections"][0]["statements"][0]["sourceStatus"] == "sourced"
    assert content["missing"] == [{"topic": "results", "description": "No results in this build."}]


def test_nothing_usable_is_none() -> None:
    assert summary.keep("not an object", CHART) is None
    assert summary.keep({"sections": [{"topic": "diagnoses", "statements": [
        {"text": "x", "sources": []}]}], "missing": []}, CHART) is None


def test_a_clean_summary_is_medium_never_high() -> None:
    draft = summary.keep({"sections": [{"topic": "encounters", "statements": [
        {"text": "One office visit.", "sources": ["S1"]}]}], "missing": []}, CHART)
    assert draft is not None and summary.band(draft) == "medium"


async def test_the_stub_summarizes_each_line_with_its_own_source() -> None:
    reply = await StubModel().complete(summary.render(_request()), max_tokens=1000,
                                       schema=summary.SUMMARY_SCHEMA)
    draft = summary.keep(json.loads(reply.content), CHART)
    assert draft is not None and draft.dropped == []
    assert {s["topic"] for s in draft.sections} == {"encounters", "diagnoses", "allergies"}
    assert draft.missing[0]["topic"] == "results"


def test_a_visit_line_has_the_visits_day_in_its_facilitys_zone() -> None:
    # 07:30 UTC on 4 November is 23:30 on 3 November in San Jose: the clinic day's last hour.
    late = datetime(2026, 11, 4, 7, 30, tzinfo=UTC)
    assert _day(late, "America/Los_Angeles") == "2026-11-03"
    assert _day(datetime(2026, 11, 4, 8, 0, tzinfo=UTC), "America/Los_Angeles") == "2026-11-04"
    assert _day(late, None) == "2026-11-04" and _day(None, "America/Los_Angeles") == "date unknown"
