"""A small JSON Schema (2020-12) checker for the keywords the partner schemas use, for the tests
only: no JSON Schema validator is in the backend's lockfiles, and adding one needs its own PR.

It knows: type, const, enum, properties, required, additionalProperties: false, items, minItems,
maxItems, uniqueItems, minLength, maxLength, pattern, format (date, date-time, uuid), minimum,
maximum, $ref to #/$defs, allOf, anyOf, not, if/then. Annotations (description, title, x-phi,
$schema, $id) are ignored. Any other keyword makes it fail loudly, so a schema can't quietly
outgrow it.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any
from uuid import UUID

ANNOTATIONS = frozenset({"$schema", "$id", "title", "description", "x-phi", "$defs", "examples"})
KNOWN = ANNOTATIONS | {
    "type", "const", "enum", "properties", "required", "additionalProperties", "items",
    "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format", "$ref",
    "allOf", "anyOf", "not", "if", "then", "minimum", "maximum",
}
TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "integer": int}


def _ecma(pattern: str) -> str:
    """A final ``$`` matches only at the very end, as in ECMA-262 (Python's also matches before a
    trailing newline)."""
    anchored = pattern.endswith("$") and not pattern.endswith("\\$")
    return pattern[:-1] + r"\Z" if anchored else pattern


def _format_ok(name: str, value: str) -> bool:
    try:
        if name == "date":
            date.fromisoformat(value)
        elif name == "date-time":
            datetime.fromisoformat(value)
        elif name == "uuid":
            UUID(value)
        else:
            raise AssertionError(f"format {name!r} is not supported by this checker")
    except ValueError:
        return False
    return True


def errors(schema: dict[str, Any], value: Any, root: dict[str, Any] | None = None,
           at: str = "") -> list[str]:
    """Where ``value`` breaks ``schema``, as JSON pointers with the keyword; [] when valid."""
    root = root if root is not None else schema
    unknown = set(schema) - KNOWN
    if unknown:
        raise AssertionError(f"{at or '/'}: keywords {sorted(unknown)} not supported here")
    found: list[str] = []

    def fail(keyword: str) -> None:
        found.append(f"{at or '/'}: {keyword}")

    if "$ref" in schema:
        ref: str = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            raise AssertionError(f"$ref {ref!r} is not supported by this checker")
        found += errors(root["$defs"][ref.removeprefix("#/$defs/")], value, root, at)
    if "type" in schema and not isinstance(value, TYPES[schema["type"]]):
        fail("type")
        return found
    if isinstance(value, bool) and schema.get("type") not in (None, "boolean"):
        fail("type")
    if isinstance(value, int) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            fail("minimum")
        if "maximum" in schema and value > schema["maximum"]:
            fail("maximum")
    if "const" in schema and value != schema["const"]:
        fail("const")
    if "enum" in schema and value not in schema["enum"]:
        fail("enum")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            fail("minLength")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            fail("maxLength")
        if "pattern" in schema and not re.search(_ecma(schema["pattern"]), value):
            fail("pattern")
        if "format" in schema and not _format_ok(schema["format"], value):
            fail("format")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            fail("minItems")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            fail("maxItems")
        if schema.get("uniqueItems") and len({repr(v) for v in value}) != len(value):
            fail("uniqueItems")
        if "items" in schema:
            for n, item in enumerate(value):
                found += errors(schema["items"], item, root, f"{at}/{n}")
    if isinstance(value, dict):
        properties: dict[str, Any] = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                fail(f"required {name}")
        if schema.get("additionalProperties") is False:
            for name in value:
                if name not in properties:
                    fail(f"additionalProperties {name}")
        for name, sub in properties.items():
            if name in value:
                found += errors(sub, value[name], root, f"{at}/{name}")
    for sub in schema.get("allOf", []):
        found += errors(sub, value, root, at)
    if "anyOf" in schema and all(errors(s, value, root, at) for s in schema["anyOf"]):
        fail("anyOf")
    if "not" in schema and not errors(schema["not"], value, root, at):
        fail("not")
    if "if" in schema and not errors(schema["if"], value, root, at) and "then" in schema:
        found += errors(schema["then"], value, root, at)
    return found
