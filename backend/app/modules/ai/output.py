"""Model output against a JSON Schema: whatever is outside the schema is dropped.

A subset of JSON Schema draft 2020-12 (the keywords NOTE_DRAFT_SCHEMA and the prompt
templates' output schemas use): ``type``, ``properties``, ``required``,
``additionalProperties: false``, ``items``, ``enum``, ``const``, ``pattern``, ``minLength``,
``maxLength``, ``minItems``, ``maxItems``, ``minimum``, ``maximum`` and local ``$ref``. A schema
with any other keyword is refused (``SchemaError``), so it can never ask for a check that is
not made. ``jsonschema`` is not in a lockfile (CLAUDE.md); hence this module.

``prune`` keeps what conforms and drops the rest, recording each dropped JSON pointer:

- an object loses properties the schema doesn't name (``additionalProperties: false``) and
  optional properties whose value fails; a failing required property drops the whole object;
- an array loses its failing items, and is cut to ``maxItems``;
- a scalar that fails its checks is dropped.

Nothing is ever repaired or invented: values are kept as they are, or dropped.
"""

from __future__ import annotations

import re
from typing import Any

SUPPORTED = frozenset({
    "$schema", "$id", "$defs", "$ref", "$comment", "title", "description", "examples",
    "type", "properties", "required", "additionalProperties", "items", "enum", "const",
    "pattern", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum",
    "default",
})

_TYPES: dict[str, tuple[type, ...]] = {
    "object": (dict,), "array": (list,), "string": (str,), "boolean": (bool,),
    "integer": (int,), "number": (int, float), "null": (type(None),),
}


class SchemaError(ValueError):
    """The schema uses a keyword this module does not check."""


class _Drop:
    """Marker: the value does not conform and is dropped."""


DROP = _Drop()


def check_schema(schema: dict[str, Any]) -> None:
    def walk(node: dict[str, Any]) -> None:
        unknown = set(node) - SUPPORTED
        if unknown:
            raise SchemaError(f"unsupported schema keyword(s): {sorted(unknown)}")
        if "additionalProperties" in node and node["additionalProperties"] is not False:
            raise SchemaError("additionalProperties must be false or absent")
        for sub in (*node.get("properties", {}).values(), *node.get("$defs", {}).values()):
            walk(sub)
        if isinstance(node.get("items"), dict):
            walk(node["items"])
    walk(schema)


def _is(value: Any, name: str) -> bool:
    if name in ("integer", "number") and isinstance(value, bool):
        return False
    return isinstance(value, _TYPES[name])


def _scalar_ok(value: Any, schema: dict[str, Any]) -> bool:
    if "const" in schema and value != schema["const"]:
        return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            return False
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            return False
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            return False
        if "maximum" in schema and value > schema["maximum"]:
            return False
    return True


def prune(value: Any, schema: dict[str, Any], *, root: dict[str, Any] | None = None,
          path: str = "", dropped: list[str] | None = None) -> tuple[Any, list[str]]:
    """``(kept, dropped pointers)``; ``kept`` is ``DROP`` when nothing of the value conforms."""
    root = root if root is not None else schema
    dropped = dropped if dropped is not None else []
    if "$ref" in schema:
        name = schema["$ref"].removeprefix("#/$defs/")
        target = root.get("$defs", {}).get(name)
        if not schema["$ref"].startswith("#/$defs/") or not isinstance(target, dict):
            raise SchemaError(f"unresolved $ref {schema['$ref']!r}")
        return prune(value, target, root=root, path=path, dropped=dropped)
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        if not any(_is(value, n) for n in names):
            dropped.append(path or "/")
            return DROP, dropped
    if not _scalar_ok(value, schema):
        dropped.append(path or "/")
        return DROP, dropped
    if isinstance(value, dict):
        props: dict[str, Any] = schema.get("properties", {})
        required = set(schema.get("required", []))
        kept: dict[str, Any] = {}
        for name, item in value.items():
            if name not in props:
                if schema.get("additionalProperties") is False:
                    dropped.append(f"{path}/{name}")
                    continue
                kept[name] = item
                continue
            sub, _ = prune(item, props[name], root=root, path=f"{path}/{name}",
                           dropped=dropped)
            if sub is DROP:
                if name in required:
                    dropped.append(path or "/")
                    return DROP, dropped
                continue
            kept[name] = sub
        if not required <= kept.keys():
            dropped.append(path or "/")
            return DROP, dropped
        return kept, dropped
    if isinstance(value, list):
        items_schema = schema.get("items")
        out: list[Any] = []
        for i, item in enumerate(value):
            sub = item
            if isinstance(items_schema, dict):
                sub, _ = prune(item, items_schema, root=root, path=f"{path}/{i}",
                               dropped=dropped)
            if sub is not DROP:
                out.append(sub)
        limit = schema.get("maxItems")
        if limit is not None and len(out) > limit:
            dropped.extend(f"{path}/{i}" for i in range(limit, len(out)))
            out = out[:limit]
        if len(out) < schema.get("minItems", 0):
            dropped.append(path or "/")
            return DROP, dropped
        return out, dropped
    return value, dropped
