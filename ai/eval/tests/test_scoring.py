"""The scores, on hand-made drafts for one visit."""

from __future__ import annotations

import json
from typing import Any

import pytest

from shri_eval.dataset import Visit, load_visits
from shri_eval.schema import validate
from shri_eval.scoring import WEIGHTS, edit_distance, parse_draft, score, similarity

from .drafts import with_inventions, with_omissions


@pytest.fixture(scope="module")
def migraine() -> Visit:
    return load_visits(["visit-01"])[0]


def _with(visit: Visit, code: str, text: str) -> str:
    draft = visit.reference_draft()
    for s in draft["sections"]:
        if s["code"] == code:
            s["text"] = text
    return json.dumps(draft)


def test_omissions_lower_coverage_and_fact_recall(migraine: Visit) -> None:
    result = score(migraine, json.dumps(with_omissions(migraine)))
    assert result.sectionCoverage < 1 and result.factRecall < 1
    assert set(result.findings["missingSections"]) == {"29545-1", "69730-0"}
    assert "f3" in result.findings["missingFacts"]              # the blood pressure
    assert result.format == 0.0                                  # the exam is required


def test_inventions_are_found(migraine: Visit) -> None:
    result = score(migraine, json.dumps(with_inventions(migraine)))
    assert [h["id"] for h in result.findings["mustNotInventHits"]] == ["n1", "n2"]
    assert result.invention < 0.6
    reasons = [r for u in result.findings["unsupportedSentences"] for r in u["reasons"]]
    assert "number:11" in reasons
    assert result.sectionCoverage == 1 and result.factRecall == 1


def test_an_unsupported_sentence_without_lexicon_words(migraine: Visit) -> None:
    result = score(migraine, _with(migraine, "10164-2",
                                   "Reports tremor while gardening, hiking and swimming."))
    [found] = result.findings["unsupportedSentences"]
    assert found["reasons"][0].startswith("support:")


def test_a_superseded_statement_is_an_invention() -> None:
    hand = load_visits(["visit-02"])[0]
    good = score(hand, json.dumps(hand.reference_draft()))
    assert good.findings["conflictsResolved"] == ["c1"]
    bad = score(hand, _with(hand, "29762-2", "Dental hygienist. Non-smoker."))
    assert bad.findings["supersededStatements"] == [{"id": "c1", "terms": ["non-smoker"]}]
    assert bad.findings["conflictsResolved"] == []
    assert bad.invention < good.invention


def test_a_wrong_dose_and_a_wrong_drug_are_term_errors(migraine: Visit) -> None:
    result = score(migraine, _with(
        migraine, "51847-2", "Chronic migraine without aura. Continue topiramate 100 mg twice a "
        "day. Start propranolol."))
    assert result.findings["doseErrors"] == [{"drug": "topiramate", "doses": ["100"]}]
    assert result.findings["wrongTerms"] == ["propranolol"]
    assert result.medicalTerms < 1


@pytest.mark.parametrize(("content", "error"), [
    ("not json", "/: not valid JSON"),
    ("[1, 2]", "/: expected object"),
    ('{"sections": "x"}', "/sections: expected array"),
    ('{"sections": [], "extra": 1}', "/extra: not allowed"),
])
def test_format_errors(migraine: Visit, content: str, error: str) -> None:
    result = score(migraine, content)
    assert error in result.findings["formatErrors"] and result.format == 0


def test_unknown_and_duplicate_codes_and_missing_required_sections(migraine: Visit) -> None:
    draft: dict[str, Any] = {"sections": [{"code": "10154-3", "text": "Migraine follow-up."},
                                          {"code": "10154-3", "text": "Again."},
                                          {"code": "11348-0", "text": "None."}]}
    errors = score(migraine, json.dumps(draft)).findings["formatErrors"]
    assert "/sections/1/code: duplicate" in errors
    assert "/sections/2/code: not a section of the FOLLOW-UP template" in errors
    assert any(e.startswith("required section 29545-1") for e in errors)


def test_think_blocks_and_code_fences_are_ignored(migraine: Visit) -> None:
    body = json.dumps(migraine.reference_draft())
    assert score(migraine, f"<think>plan the note</think>\n```json\n{body}\n```").overall == 1.0
    draft, errors = parse_draft("```\n{}\n```")
    assert draft == {} and errors == []


def test_an_empty_draft_scores_zero_for_invention(migraine: Visit) -> None:
    result = score(migraine, '{"sections": []}')
    assert result.invention == 0 and result.sectionCoverage == 0


def test_the_validator_handles_refs_enums_and_bounds() -> None:
    schema: dict[str, Any] = {"type": "object", "properties": {
        "a": {"$ref": "#/$defs/small"}, "b": {"enum": ["x"]}, "c": {"type": "integer"}},
        "$defs": {"small": {"type": "number", "minimum": 0, "maximum": 2}}}
    assert validate({"a": 1, "b": "x", "c": 3}, schema) == []
    assert validate({"a": 3, "b": "y", "c": True}, schema) == [
        "/a: above 2", "/b: not one of the allowed values", "/c: expected integer"]


def test_edit_distance_counts_word_edits() -> None:
    assert edit_distance([], []) == 0
    assert edit_distance(["a", "b", "c"], ["a", "b", "c"]) == 0
    assert edit_distance(["a", "b", "c"], ["a", "x", "c"]) == 1  # one replaced
    assert edit_distance(["a", "b", "c"], ["a", "c"]) == 1  # one deleted
    assert edit_distance(["a"], ["b", "c", "d"]) == 3
    assert similarity("", "") == (1.0, 0)
    assert similarity("headache for two days", "headache for three days") == (0.75, 1)


def test_edit_similarity_is_measured_and_not_weighted(migraine: Visit) -> None:
    reference = score(migraine, json.dumps(migraine.reference_draft()))
    assert reference.editSimilarity == 1.0 and reference.findings["editDistanceWords"] == 0
    assert set(reference.findings["sectionEditSimilarity"].values()) == {1.0}
    code = next(iter(migraine.reference_sections))
    changed = score(migraine, _with(migraine, code, "Patient seen today."))
    assert 0 < changed.editSimilarity < 1
    by_section = changed.findings["sectionEditSimilarity"]
    assert by_section[code] < 1 and all(v == 1.0 for c, v in by_section.items() if c != code)
    empty = score(migraine, json.dumps({"sections": []}))
    assert empty.editSimilarity == 0.0
    weighted = sum(WEIGHTS[k] * getattr(reference, k) for k in WEIGHTS)
    assert reference.overall == round(weighted, 4)  # editSimilarity isn't in overall
