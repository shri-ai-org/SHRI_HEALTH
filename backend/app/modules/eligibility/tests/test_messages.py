"""The clearinghouse message shapes (contracts/partners/clearinghouse/) and their Pydantic mirror
(messages.py) agree: the recorded synthetic examples are valid under both, every mutation of an
example is refused by both or accepted by both, and both name the same fields. No database."""

from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from .. import messages as m
from .schema_check import errors

REPO = Path(__file__).resolve().parents[5]
SHAPES = REPO / "contracts" / "partners" / "clearinghouse"
REQUEST = json.loads((SHAPES / "eligibility-request.schema.json").read_text(encoding="utf-8"))
RESPONSE = json.loads((SHAPES / "eligibility-response.schema.json").read_text(encoding="utf-8"))
EXAMPLES = sorted((SHAPES / "examples").glob("*.json"))


def example(name: str) -> dict[str, Any]:
    found: dict[str, Any] = json.loads((SHAPES / "examples" / name).read_text(encoding="utf-8"))
    return found


def _pair(path: Path) -> tuple[dict[str, Any], type[BaseModel]]:
    if path.name.startswith("request"):
        return REQUEST, m.EligibilityRequest
    return RESPONSE, m.EligibilityResponse


def _pydantic_ok(model: type[BaseModel], value: Any) -> bool:
    try:
        model.model_validate(value)
    except ValidationError:
        return False
    return True


def test_both_schemas_are_2020_12_with_their_examples() -> None:
    for schema in (REQUEST, RESPONSE):
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    names = {p.name for p in EXAMPLES}
    assert {"request-subscriber.json", "request-dependent.json", "response-active-copay.json",
            "response-inactive.json", "response-payer-error.json",
            "response-member-not-found.json"} <= names


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_every_example_is_valid_under_both(path: Path) -> None:
    schema, model = _pair(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    assert errors(schema, value) == []
    parsed = model.model_validate(value)
    assert isinstance(parsed, m.Message) and parsed.as_json() == value  # nothing lost or added


def _mutations(value: Any, at: tuple[Any, ...] = ()) -> Iterator[tuple[str, tuple[Any, ...], Any]]:
    """(what, where, new value or a marker) for every node of an example."""
    if isinstance(value, dict):
        yield "add", at, None
        for key, child in value.items():
            yield "drop", (*at, key), None
            yield "null", (*at, key), None
            yield from _mutations(child, (*at, key))
    elif isinstance(value, list):
        yield "set", at, []
        if value:
            yield "set", at, [*value, value[0]]
            yield "set", at, value * 300
        for n, child in enumerate(value):
            yield from _mutations(child, (*at, n))
    elif isinstance(value, bool):
        yield "set", at, "true"
    elif isinstance(value, str):
        for bad in ("", "x" * 600, "not valid!", 12345, "2026-02-30", value + "\n"):
            yield "set", at, bad


def _apply(value: Any, what: str, where: tuple[Any, ...], new: Any) -> Any:
    changed = copy.deepcopy(value)
    if what == "add" and not where:
        changed["unexpectedMember"] = 1
        return changed
    parent = changed
    for step in where[:-1] if where else ():
        parent = parent[step]
    if what == "add":
        parent[where[-1]]["unexpectedMember"] = 1
    elif what == "drop":
        del parent[where[-1]]
    elif what == "null":
        parent[where[-1]] = None
    elif not where:
        return new
    else:
        parent[where[-1]] = new
    return changed


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_the_schema_and_the_model_agree_on_every_mutation(path: Path) -> None:
    schema, model = _pair(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    disagreements = []
    refused = 0
    for what, where, new in _mutations(value):
        changed = _apply(value, what, where, new)
        by_schema = errors(schema, changed) == []
        by_model = _pydantic_ok(model, changed)
        refused += not by_schema
        if by_schema != by_model:
            disagreements.append((what, where, repr(new)[:20], by_schema, by_model))
    assert disagreements == []
    assert refused > 20  # the mutations really test something


def test_the_result_rules() -> None:
    error = example("response-payer-error.json")
    del error["errors"]
    not_found = example("response-member-not-found.json") | {"plan": {"name": "Test PPO"}}
    inactive_with_benefits = example("response-inactive.json") | {
        "benefits": [{"benefitType": "active-coverage"}]}
    for value, valid in ((error, False), (not_found, False), (inactive_with_benefits, True)):
        assert (errors(RESPONSE, value) == []) is valid
        assert _pydantic_ok(m.EligibilityResponse, value) is valid


def test_amounts_and_percentages_are_strings_never_numbers() -> None:
    reply = example("response-active-copay.json")
    reply["benefits"][1]["amount"]["value"] = 25.0
    assert errors(RESPONSE, reply) != [] and not _pydantic_ok(m.EligibilityResponse, reply)
    reply = example("response-active-copay.json")
    reply["benefits"][6]["percent"] = 20
    assert errors(RESPONSE, reply) != [] and not _pydantic_ok(m.EligibilityResponse, reply)


def _properties(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in schema:
        return _properties(root["$defs"][schema["$ref"].removeprefix("#/$defs/")], root)
    found: dict[str, Any] = schema["properties"]
    return found


PAIRS: list[tuple[dict[str, Any], tuple[str, ...], type[BaseModel]]] = [
    (REQUEST, (), m.EligibilityRequest),
    (REQUEST, ("payer",), m.RequestPayer),
    (REQUEST, ("provider",), m.RequestProvider),
    (REQUEST, ("subscriber",), m.Subscriber),
    (REQUEST, ("subscriber", "name"), m.PersonName),
    (REQUEST, ("dependent",), m.Dependent),
    (RESPONSE, (), m.EligibilityResponse),
    (RESPONSE, ("plan",), m.Plan),
    (RESPONSE, ("errors",), m.PayerError),
    (RESPONSE, ("benefits",), m.Benefit),
    (RESPONSE, ("benefits", "amount"), m.Money),
]


@pytest.mark.parametrize(("schema", "path", "model"), PAIRS,
                         ids=[f"{p[2].__name__}" for p in PAIRS])
def test_the_schema_and_the_model_name_the_same_fields(
        schema: dict[str, Any], path: tuple[str, ...], model: type[BaseModel]) -> None:
    node = schema
    for step in path:
        node = _properties(node, schema)[step]
        node = node.get("items", node)
        if "$ref" in node:
            node = schema["$defs"][node["$ref"].removeprefix("#/$defs/")]
    fields = {f.alias or name: f for name, f in model.model_fields.items()}
    assert set(fields) == set(_properties(node, schema))
    assert {a for a, f in fields.items() if f.is_required()} == set(node.get("required", []))


def test_every_field_is_marked_with_its_sensitivity() -> None:
    """x-phi on every property, with the API contract's values (EXTENSIONS.md)."""
    allowed = {"identifier", "clinical", "financial", "internal-id", "none"}
    missing = []

    def walk(node: Any, where: str) -> None:
        if isinstance(node, dict):
            for name, sub in node.get("properties", {}).items():
                if sub.get("x-phi") not in allowed:
                    missing.append(f"{where}/{name}")
            for key, sub in node.items():
                if key != "allOf":  # the result rules' `if` names fields, it doesn't define them
                    walk(sub, f"{where}/{key}")
        elif isinstance(node, list):
            for n, sub in enumerate(node):
                walk(sub, f"{where}/{n}")

    walk(REQUEST, "request")
    walk(RESPONSE, "response")
    assert missing == []
