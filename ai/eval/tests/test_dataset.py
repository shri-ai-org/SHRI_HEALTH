"""The fictional visit set: shape, synthetic-only data, and that its scoring keys are consistent
(key facts are in the transcript and the reference, inventions in neither, and the reference
note itself scores perfectly)."""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

import pytest

from shri_eval import text as tx
from shri_eval.dataset import (
    DRAFT_SCHEMA,
    TEMPLATES,
    VISIT_SCHEMA,
    Visit,
    load_json,
    load_visits,
    visit_files,
)
from shri_eval.schema import check_schema, validate
from shri_eval.scoring import score

FILES = visit_files()
SEED = Path(__file__).resolve().parents[3] / "backend" / "app" / "db" / "seed" / "starter.py"


def _visit(path: Path) -> Visit:
    return Visit(load_json(path))


def test_the_schemas_use_only_supported_keywords() -> None:
    check_schema(load_json(VISIT_SCHEMA))
    check_schema(load_json(DRAFT_SCHEMA))


def test_there_are_ten_visits_across_specialties_including_neurology() -> None:
    visits = load_visits()
    assert len(visits) == 10
    assert [v.id for v in visits] == [f"visit-{i:02d}" for i in range(1, 11)]
    specialties = {v.data["specialty"] for v in visits}
    assert "neurology" in specialties and len(specialties) >= 8
    assert sum(len(v.data["conflicts"]) for v in visits) >= 1


@pytest.mark.parametrize("path", FILES, ids=[p.stem for p in FILES])
def test_every_file_matches_the_schema(path: Path) -> None:
    data = load_json(path)
    assert validate(data, load_json(VISIT_SCHEMA)) == []
    assert data["id"] == path.stem


def test_the_schema_refuses_a_bad_file() -> None:
    bad: dict[str, Any] = load_json(FILES[0])
    bad["synthetic"] = False
    bad["patient"]["name"] = "Jane Doe"
    del bad["keyFacts"]
    errors = validate(bad, load_json(VISIT_SCHEMA))
    assert any(e.startswith("/synthetic") for e in errors)
    assert any(e.startswith("/patient/name") for e in errors)
    assert "/keyFacts: required" in errors


@pytest.mark.parametrize("path", FILES, ids=[p.stem for p in FILES])
def test_the_reference_note_has_its_templates_sections(path: Path) -> None:
    visit = _visit(path)
    sections = visit.data["referenceNote"]["sections"]
    assert [(s["code"], s["title"], s["required"]) for s in sections] == list(visit.template)
    assert [s["sequence"] for s in sections] == list(range(1, len(sections) + 1))
    assert all(s["text"].strip() for s in sections if s["required"])
    assert "69730-0" in visit.reference_sections        # patient instructions
    noun = {"NEW-VISIT": "34117-2", "FOLLOW-UP": "11506-3"}[visit.data["template"]]
    assert visit.data["noteType"] == noun


@pytest.mark.parametrize("path", FILES, ids=[p.stem for p in FILES])
def test_the_scoring_keys_are_consistent(path: Path) -> None:
    visit = _visit(path)
    source, reference = visit.source_text, "\n".join(visit.reference_sections.values())
    for fact in visit.data["keyFacts"]:
        assert tx.any_term(reference, fact["anyOf"]), fact["id"]
        assert tx.any_term(source, fact["anyOf"]), fact["id"]
        assert tx.any_term(visit.reference_sections[fact["section"]], fact["anyOf"]), fact["id"]
    for item in visit.data["mustNotInvent"]:
        assert not tx.any_term(source, item["anyOf"]), item["id"]
        assert not tx.any_term(reference, item["anyOf"]), item["id"]
    for c in visit.data["conflicts"]:
        assert all(t < len(visit.data["transcript"]) for t in c["turns"])
        assert tx.any_term(reference, c["resolvedAnyOf"]), c["id"]
        assert not tx.any_term(reference, c["supersededAnyOf"]), c["id"]
    for term in visit.data["medicalTerms"]:
        assert tx.has_term(reference, term), term


@pytest.mark.parametrize("path", FILES, ids=[p.stem for p in FILES])
def test_only_synthetic_contact_details(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    for email in re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", raw):
        assert email.endswith("@example.com"), email
    for phone in re.findall(r"\b\d{3}-\d{4}\b", raw):
        assert re.fullmatch(r"555-01\d\d", phone), phone
    assert not re.search(r"\b\d{3}-\d{2}-\d{4}\b", raw)        # nothing shaped like an SSN
    data = load_json(path)
    assert data["synthetic"] is True
    assert re.search(r"\d", data["patient"]["name"])               # Synthea-style digits


@pytest.mark.parametrize("path", FILES, ids=[p.stem for p in FILES])
def test_the_reference_note_scores_perfectly(path: Path) -> None:
    """The baseline finds no invention, omission or term error in the reference note."""
    visit = _visit(path)
    result = score(visit, json.dumps(visit.reference_draft()))
    assert result.findings["unsupportedSentences"] == []
    assert result.findings["formatErrors"] == []
    assert result.findings["wrongTerms"] == []
    assert result.overall == 1.0, result.findings


@pytest.mark.skipif(not SEED.exists(), reason="the backend seed is not in this checkout")
def test_the_templates_match_the_seed() -> None:
    tree = ast.parse(SEED.read_text(encoding="utf-8"))
    names: dict[str, ast.expr] = {}
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value:
            names[node.target.id] = node.value
        elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            names[node.targets[0].id] = node.value
    new_visit = ast.literal_eval(names["_NEW_VISIT_SECTIONS"])
    seed: dict[str, Any] = {}
    templates = names["NOTE_TEMPLATES"]
    assert isinstance(templates, ast.Tuple)
    for entry in templates.elts:
        assert isinstance(entry, ast.Tuple)
        code = ast.literal_eval(entry.elts[0])
        sections = entry.elts[3]
        if isinstance(sections, ast.Name):
            seed[code] = new_visit
        elif isinstance(sections, ast.Tuple):
            seed[code] = ast.literal_eval(sections)
    assert seed["NEW-VISIT"] == TEMPLATES["NEW-VISIT"]
    assert seed["FOLLOW-UP"] == TEMPLATES["FOLLOW-UP"]
