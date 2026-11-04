"""A small JSON Schema validator (a subset of draft 2020-12), standard library only.

Supported keywords: ``type`` (one or a list), ``properties``, ``required``,
``additionalProperties`` (boolean), ``items``, ``enum``, ``const``, ``pattern``, ``minLength``,
``maxLength``, ``minItems``, ``maxItems``, ``minimum``, ``maximum``, ``uniqueItems`` and local
``$ref`` (``#/$defs/<name>``). Any other keyword is refused, so a schema can never silently ask
for a check this validator does not make.

``jsonschema`` is not in a lockfile (CLAUDE.md), hence this file.
"""

from __future__ import annotations

import re
from typing import Any

SUPPORTED = frozenset({
    "$schema", "$id", "$defs", "$ref", "$comment", "title", "description", "examples",
    "type", "properties", "required", "additionalProperties", "items", "enum", "const",
    "pattern", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum",
    "uniqueItems", "default",
})

_TYPES: dict[str, tuple[type, ...]] = {
    "object": (dict,), "array": (list,), "string": (str,), "boolean": (bool,),
    "integer": (int,), "number": (int, float), "null": (type(None),),
}


class SchemaError(ValueError):
    """The schema itself uses a keyword this validator does not support."""


def _is_type(value: Any, name: str) -> bool:
    if name in ("integer", "number") and isinstance(value, bool):
        return False
    return isinstance(value, _TYPES[name])


def _resolve(ref: str, root: dict[str, Any]) -> dict[str, Any]:
    prefix = "#/$defs/"
    if not ref.startswith(prefix):
        raise SchemaError(f"only local $defs references are supported, got {ref!r}")
    target = root.get("$defs", {}).get(ref[len(prefix):])
    if not isinstance(target, dict):
        raise SchemaError(f"unresolved $ref {ref!r}")
    return target


def check_schema(schema: dict[str, Any], root: dict[str, Any] | None = None) -> None:
    """Raises SchemaError for any keyword outside SUPPORTED, anywhere in the schema."""
    root = root or schema
    unknown = set(schema) - SUPPORTED
    if unknown:
        raise SchemaError(f"unsupported keyword(s): {sorted(unknown)}")
    for sub in schema.get("properties", {}).values():
        check_schema(sub, root)
    for sub in schema.get("$defs", {}).values():
        check_schema(sub, root)
    if isinstance(schema.get("items"), dict):
        check_schema(schema["items"], root)


def validate(instance: Any, schema: dict[str, Any], root: dict[str, Any] | None = None,
             path: str = "") -> list[str]:
    """Every error as ``<JSON pointer>: <message>``; an empty list means valid."""
    root = root or schema
    if "$ref" in schema:
        return validate(instance, _resolve(schema["$ref"], root), root, path)
    errors: list[str] = []
    where = path or "/"
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        if not any(_is_type(instance, n) for n in names):
            return [f"{where}: expected {'/'.join(names)}"]
    if "const" in schema and instance != schema["const"]:
        errors.append(f"{where}: must be {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{where}: not one of the allowed values")
    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{where}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            errors.append(f"{where}: longer than {schema['maxLength']}")
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            errors.append(f"{where}: does not match {schema['pattern']!r}")
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{where}: below {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{where}: above {schema['maximum']}")
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{where}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{where}: more than {schema['maxItems']} items")
        if schema.get("uniqueItems"):
            seen: list[Any] = []
            for item in instance:
                if item in seen:
                    errors.append(f"{where}: items are not unique")
                    break
                seen.append(item)
        if isinstance(schema.get("items"), dict):
            for i, item in enumerate(instance):
                errors.extend(validate(item, schema["items"], root, f"{path}/{i}"))
    if isinstance(instance, dict):
        props: dict[str, Any] = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in instance:
                errors.append(f"{path}/{name}: required")
        for name, value in instance.items():
            if name in props:
                errors.extend(validate(value, props[name], root, f"{path}/{name}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}/{name}: not allowed")
    return errors
