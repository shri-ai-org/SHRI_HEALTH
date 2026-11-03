"""Pruning model output to its JSON Schema, and the schema the evaluation harness shares."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.modules.ai.output import DROP, SchemaError, check_schema, prune
from app.modules.ai.schemas import NOTE_DRAFT_SCHEMA

EVAL_SCHEMA = Path(__file__).resolve().parents[5] / "ai" / "eval" / "data" / \
    "note_draft.schema.json"


@pytest.mark.skipif(not EVAL_SCHEMA.exists(), reason="ai/ is not in this checkout")
def test_the_gateway_and_the_harness_use_the_same_schema() -> None:
    assert NOTE_DRAFT_SCHEMA == json.loads(EVAL_SCHEMA.read_text(encoding="utf-8"))


def test_a_conforming_draft_is_kept_whole() -> None:
    draft = {"sections": [{"code": "10154-3", "text": "Headache."}], "unknowns": ["BP"]}
    assert prune(draft, NOTE_DRAFT_SCHEMA) == (draft, [])


def test_what_does_not_conform_is_dropped_and_listed() -> None:
    kept, dropped = prune({"sections": [{"code": "10154-3", "text": "ok", "x": 1},
                                        {"code": "10154-3"},
                                        "text"],
                           "unknowns": [""] * 3, "extra": True}, NOTE_DRAFT_SCHEMA)
    assert kept == {"sections": [{"code": "10154-3", "text": "ok"}], "unknowns": []}
    assert dropped == ["/sections/0/x", "/sections/1", "/sections/2", "/unknowns/0",
                       "/unknowns/1", "/unknowns/2", "/extra"]


@pytest.mark.parametrize("value", ["text", [], None, {"unknowns": []}, {"sections": "x"}])
def test_a_draft_without_its_required_sections_is_dropped(value: Any) -> None:
    kept, dropped = prune(value, NOTE_DRAFT_SCHEMA)
    assert kept is DROP and dropped


def test_arrays_are_cut_to_max_items() -> None:
    kept, dropped = prune({"sections": [{"code": "1-1", "text": ""}] * 22}, NOTE_DRAFT_SCHEMA)
    assert len(kept["sections"]) == 20 and dropped == ["/sections/20", "/sections/21"]


def test_refs_bounds_and_enums() -> None:
    schema: dict[str, Any] = {"type": "object", "properties": {
        "band": {"enum": ["low", "medium", "high"]}, "n": {"$ref": "#/$defs/small"},
        "flag": {"type": "boolean"}, "id": {"type": "integer"}},
        "$defs": {"small": {"type": "number", "minimum": 0, "maximum": 1}}}
    kept, dropped = prune({"band": "certain", "n": 2, "flag": 1, "id": True}, schema)
    assert kept == {} and dropped == ["/band", "/n", "/flag", "/id"]
    assert prune({"band": "low", "n": 0.5, "flag": False, "id": 3}, schema)[1] == []


@pytest.mark.parametrize("schema", [{"type": "object", "oneOf": []},
                                    {"properties": {"a": {"format": "date"}}},
                                    {"additionalProperties": True},
                                    {"items": {"anyOf": []}}])
def test_a_schema_asking_for_unchecked_keywords_is_refused(schema: dict[str, Any]) -> None:
    with pytest.raises(SchemaError):
        check_schema(schema)


def test_the_draft_schema_uses_only_checked_keywords() -> None:
    check_schema(NOTE_DRAFT_SCHEMA)
