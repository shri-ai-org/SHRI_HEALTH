"""The pharmacy message shapes (contracts/partners/pharmacy/) and their Pydantic mirror
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

from app.modules.eligibility.tests.schema_check import errors

from .. import messages as m

REPO = Path(__file__).resolve().parents[5]
SHAPES = REPO / "contracts" / "partners" / "pharmacy"
NEW_RX = json.loads((SHAPES / "new-rx.schema.json").read_text(encoding="utf-8"))
RX_STATUS = json.loads((SHAPES / "rx-status.schema.json").read_text(encoding="utf-8"))
EXAMPLES = sorted((SHAPES / "examples").glob("*.json"))


def example(name: str) -> dict[str, Any]:
    found: dict[str, Any] = json.loads((SHAPES / "examples" / name).read_text(encoding="utf-8"))
    return found


def _pair(path: Path) -> tuple[dict[str, Any], type[BaseModel]]:
    if path.name.startswith("new-rx"):
        return NEW_RX, m.NewRx
    return RX_STATUS, m.RxStatus


def _pydantic_ok(model: type[BaseModel], value: Any) -> bool:
    try:
        model.model_validate(value)
    except ValidationError:
        return False
    return True


def test_both_schemas_are_2020_12_with_their_examples() -> None:
    for schema in (NEW_RX, RX_STATUS):
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert {p.name for p in EXAMPLES} >= {
        "new-rx-amoxicillin.json", "new-rx-text-only.json", "rx-status-accepted.json",
        "rx-status-rejected.json", "rx-status-rejected-code-only.json"}


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
        yield "set", at, 1
    elif isinstance(value, int):
        for bad in (-1, 0, 1, 11, 12, 365, 366, 1.5, 2.0, "3", True):
            yield "set", at, bad
    elif isinstance(value, str):
        for bad in ("", "x" * 600, "not valid!", 12345, "2026-02-30", value + "\n", "0", "0.000",
                    "1.2345", "1234567", "12.5", "CII", "CVI", "9999", "12345678901"):
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


def test_the_status_rules() -> None:
    rejected = example("rx-status-rejected.json")
    del rejected["rejection"]
    accepted = example("rx-status-accepted.json") | {"rejection": {"code": "900"}}
    for value in (rejected, accepted):
        assert errors(RX_STATUS, value) != []
        assert not _pydantic_ok(m.RxStatus, value)


def test_quantities_are_decimal_strings_greater_than_zero() -> None:
    for bad in (30, 30.0, "0", "00.00", "-1", "1e3", "1.2345"):
        rx = example("new-rx-amoxicillin.json")
        rx["medication"]["quantity"]["value"] = bad
        assert errors(NEW_RX, rx) != [] and not _pydantic_ok(m.NewRx, rx), bad
    for good in ("0.5", "30", "100000", "44.125"):
        rx = example("new-rx-amoxicillin.json")
        rx["medication"]["quantity"]["value"] = good
        assert errors(NEW_RX, rx) == [] and _pydantic_ok(m.NewRx, rx), good


def test_nothing_about_the_patient_beyond_name_and_birth_date() -> None:
    """Minimum necessary: no SSN, address, phone, gender, insurance or diagnosis anywhere."""
    text = json.dumps(NEW_RX).lower()
    for word in ("ssn", "social", "address", "phone", "gender", "insurance", "diagnosis"):
        assert f'"{word}' not in text, word
    assert set(NEW_RX["properties"]["patient"]["properties"]) == {"name", "birthDate"}


def _properties(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in schema:
        return _properties(root["$defs"][schema["$ref"].removeprefix("#/$defs/")], root)
    found: dict[str, Any] = schema["properties"]
    return found


PAIRS: list[tuple[dict[str, Any], tuple[str, ...], type[BaseModel]]] = [
    (NEW_RX, (), m.NewRx),
    (NEW_RX, ("prescriber",), m.Prescriber),
    (NEW_RX, ("prescriber", "name"), m.PersonName),
    (NEW_RX, ("patient",), m.Patient),
    (NEW_RX, ("pharmacy",), m.Pharmacy),
    (NEW_RX, ("medication",), m.Medication),
    (NEW_RX, ("medication", "quantity"), m.Quantity),
    (RX_STATUS, (), m.RxStatus),
    (RX_STATUS, ("rejection",), m.Rejection),
]


@pytest.mark.parametrize(("schema", "path", "model"), PAIRS,
                         ids=[f"{p[2].__name__}" for p in PAIRS])
def test_the_schema_and_the_model_name_the_same_fields(
        schema: dict[str, Any], path: tuple[str, ...], model: type[BaseModel]) -> None:
    node = schema
    for step in path:
        node = _properties(node, schema)[step]
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
                if key != "allOf":  # the status rules' `if` names fields, it doesn't define them
                    walk(sub, f"{where}/{key}")
        elif isinstance(node, list):
            for n, sub in enumerate(node):
                walk(sub, f"{where}/{n}")

    walk(NEW_RX, "new-rx")
    walk(RX_STATUS, "rx-status")
    assert missing == []
