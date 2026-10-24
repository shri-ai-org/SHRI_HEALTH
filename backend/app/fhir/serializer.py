"""Turn FHIR-shaped rows into FHIR R4 JSON, driven entirely by the column / relationship
``info`` metadata the models declare (``app.db.fhir_types``). The same code serializes live
ORM objects and ``fhir_resource_history`` snapshots, so ``read`` and ``vread`` agree.

Rules:
* columns with the same ``fhir`` element form one value (CodeableConcept, Quantity, Period,
  Reference ...); dotted elements (``dispenseRequest.quantity``) nest; names listed in a
  model's ``__fhir_lists__`` wrap their nested object in a one-item list.
* ``children(..., element)`` relationships become lists (or one object with ``single``);
  ``spread`` children add their elements to the parent's lists (reasonCode / reasonReference);
  tables with ``fhir_coding_of`` add extra codings to that element.
* references to admin tables (payer, pharmacy) become logical references (identifier).
"""
from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any, Protocol

from sqlalchemy import inspect

from app.db.models import FHIR_RESOURCES, MAPPERS, systems

CONFIDENTIALITY = {"L", "M", "N", "R", "V"}
US_CORE = "http://hl7.org/fhir/us/core/StructureDefinition"
RESOURCE_TABLES = {cls.__tablename__ for cls in FHIR_RESOURCES.values()}
SKIP_PARTS = {"system", "code", "display", "text"}


# --------------------------------------------------------------------------- row adapters
class Row(Protocol):
    def get(self, column: str) -> Any: ...
    def children(self, rel_key: str, target_table: str, fk: str) -> list[Row]: ...


class OrmRow:
    def __init__(self, obj: Any):
        self.obj = obj
        self._cols = {c.name: a.key for a in inspect(type(obj)).column_attrs
                      for c in a.columns}

    def get(self, column: str) -> Any:
        return getattr(self.obj, self._cols.get(column, column), None)

    def children(self, rel_key: str, target_table: str, fk: str) -> list[Row]:
        return [OrmRow(o) for o in (getattr(self.obj, rel_key) or [])]


class SnapshotRow:
    """A row from fhir_resource_history.snapshot (to_jsonb of the row + ``_children``)."""

    def __init__(self, data: dict[str, Any]):
        self.data = data

    def get(self, column: str) -> Any:
        return self.data.get(column)

    def children(self, rel_key: str, target_table: str, fk: str) -> list[Row]:
        kids = self.data.get("_children", {})
        rows = kids.get(target_table, kids.get(f"{target_table}.{fk}", []))
        return [SnapshotRow(r) for r in rows]


# --------------------------------------------------------------------------- value builders
def _prim(v: Any, ftype: str) -> Any:
    if v is None:
        return None
    if ftype in ("dateTime", "instant"):
        if isinstance(v, str):
            v = dt.datetime.fromisoformat(v)
        if isinstance(v, dt.datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=dt.UTC)
            return v.isoformat()
        return v.isoformat()
    if ftype == "date":
        return v if isinstance(v, str) else v.isoformat()
    if ftype in ("decimal",):
        return float(v) if isinstance(v, Decimal) else v
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def _num(v: Any) -> Any:
    if v is None:
        return None
    d = Decimal(str(v))
    return int(d) if d == d.to_integral_value() else float(d)


def _clean(d: dict[str, Any]) -> dict[str, Any] | None:
    d = {k: v for k, v in d.items() if v not in (None, [], {}, "")}
    return d or None


def _cols_by_part(cols: list[Any]) -> dict[str, Any]:
    return {c.info.get("part", "value"): c for c in cols}


def _value(cols: list[Any], row: Row, cls: type[Any]) -> Any:
    info = cols[0].info
    ftype = info["fhir_type"]
    parts = _cols_by_part(cols)

    def g(part: str) -> Any:
        return row.get(parts[part].name) if part in parts else None

    if ftype == "CodeableConcept":
        fixed = next((c.info.get("fixed_system") for c in cols if c.info.get("fixed_system")),
                     None)
        if fixed:
            v = g("code")
            if not v:
                return None
            if isinstance(v, list):
                return [{"coding": [{"system": fixed, "code": x}]} for x in v] or None
            return {"coding": [{"system": fixed, "code": v}]}
        coding = _clean({"system": g("system"), "code": g("code"), "display": g("display")})
        cc = _clean({"coding": [coding] if coding and coding.get("code") else None,
                     "text": g("text")})
        return cc
    if ftype == "Coding":
        fixed = next((c.info.get("fixed_system") for c in cols if c.info.get("fixed_system")),
                     None)
        if fixed:
            v = g("code")
            return {"system": fixed, "code": v} if v else None
        return _clean({"system": g("system"), "code": g("code"), "display": g("display")})
    if ftype in ("Quantity", "Age", "Duration", "SimpleQuantity"):
        return _clean({"value": _num(g("value")), "comparator": g("comparator"),
                       "unit": g("unit"), "system": g("system"), "code": g("code")})
    if ftype == "Money":
        return _clean({"value": _num(g("value")), "currency": g("currency")}) \
            if g("value") is not None else None
    if ftype == "Period":
        kind = "date" if str(parts["start"].type) == "DATE" else "dateTime"
        return _clean({"start": _prim(g("start"), kind), "end": _prim(g("end"), kind)})
    if ftype == "Range":
        lo = _clean({"value": _num(g("low.value")), "unit": g("low.unit"),
                     "system": systems.UCUM if g("low.code") else None, "code": g("low.code")})
        hi = _clean({"value": _num(g("high.value")), "unit": g("high.unit"),
                     "system": systems.UCUM if g("high.code") else None, "code": g("high.code")})
        return _clean({"low": lo, "high": hi})
    if ftype == "Identifier":
        return _clean({"system": g("system"), "value": g("value")})
    if ftype == "Attachment":
        binary = g("binary")
        return _clean({"contentType": g("contentType"),
                       "url": f"Binary/{binary}" if binary else None,
                       "title": g("title"), "creation": _prim(g("creation"), "dateTime")})
    if ftype == "Reference":
        ref: dict[str, Any] = {}
        for c in cols:
            v = row.get(c.name)
            if v is None or not c.foreign_keys:
                continue
            target = next(iter(c.foreign_keys)).column.table.name
            if target in RESOURCE_TABLES:
                ref["reference"] = f"{c.info['ref_type']}/{v}"
            else:   # admin directory (payer, pharmacy): logical reference
                ref["type"] = c.info["ref_type"]
                ref["identifier"] = {"system": f"{systems.SHRI}/sid/{target}", "value": str(v)}
        ident = _clean({"system": g("identifier.system"), "value": g("identifier.value")})
        if ident:
            ref["identifier"] = ident
        if g("display"):
            ref["display"] = g("display")
        return ref or None
    # primitives
    v = row.get(cols[0].name)
    if info.get("many"):
        return [_prim(x, ftype) for x in v] if v else None
    if ftype in ("integer", "positiveInt", "unsignedInt"):
        return int(v) if v is not None else None
    if ftype == "decimal":
        return _num(v)
    return _prim(v, ftype)


def _set(out: dict[str, Any], path: str, value: Any, many: bool, lists: set[str]) -> None:
    keys = path.split(".")
    node = out
    for k in keys[:-1]:
        if k in lists:
            node = node.setdefault(k, [{}])[0]
        else:
            node = node.setdefault(k, {})
    last = keys[-1]
    if many and not isinstance(value, list):
        value = [value]
    if isinstance(value, list) and last in node and isinstance(node[last], list):
        node[last].extend(value)
    else:
        node[last] = value


# --------------------------------------------------------------------------- serialize
def _element_groups(cls: type[Any]) -> list[tuple[str, list[Any]]]:
    groups: dict[str, list[Any]] = {}
    for col in cls.__table__.columns:
        el = col.info.get("fhir")
        if el and el != "meta.security":
            groups.setdefault(el, []).append(col)
    return list(groups.items())


def serialize_row(cls: type[Any], row: Row) -> Any:
    out: dict[str, Any] = {}
    lists = set(getattr(cls, "__fhir_lists__", set()))
    for el, cols in _element_groups(cls):
        value = _value(cols, row, cls)
        if value is None:
            continue
        if el == ".":
            return value
        many = any(c.info.get("many") for c in cols)
        _set(out, el, value, many, lists)

    exts: list[dict[str, Any]] = []
    for col in cls.__table__.columns:
        url = col.info.get("fhir_ext")
        if url and row.get(col.name) is not None:
            exts.append({"url": url, "valueCode": row.get(col.name)})
    if exts:
        out["extension"] = exts

    for rel in inspect(cls).relationships:
        if "fhir" not in rel.info:
            continue
        target = rel.mapper.class_
        fk = next(iter(rel._calculated_foreign_keys)).name
        kids = row.children(rel.key, target.__tablename__, fk)
        if not kids:
            continue
        coding_of = getattr(target, "fhir_coding_of", None)
        if coding_of:
            cc = out.setdefault(coding_of, {})
            cc.setdefault("coding", []).extend(
                _clean({"system": k.get("system"), "code": k.get("code"),
                        "display": k.get("display")}) for k in kids)
            continue
        if rel.info.get("spread"):
            for k in kids:
                part = serialize_row(target, k)
                for key, val in (part or {}).items():
                    _set(out, key, val if isinstance(val, list) else [val], True, set())
            continue
        if rel.info["fhir"] is None:
            continue
        items = [v for v in (serialize_row(target, k) for k in kids) if v]
        if items:
            out[rel.info["fhir"]] = items[0] if rel.info.get("single") else items
    hook = getattr(cls, "fhir_hook", None)
    if hook:
        hook(row, out)
    return out


def _meta(cls: type[Any], row: Row) -> dict[str, Any]:
    meta: dict[str, Any] = {"versionId": str(row.get("meta_version_id")),
                            "lastUpdated": _prim(row.get("meta_last_updated"), "instant")}
    sec = row.get("meta_security") or []
    if sec:
        meta["security"] = [{"system": systems.V3_CONFIDENTIALITY if s in CONFIDENTIALITY
                             else systems.V3_ACT_CODE, "code": s} for s in sec]
    if "entry_source" in cls.__table__.c and row.get("entry_source"):
        meta["tag"] = [{"system": systems.SHRI_ENTRY_SOURCE, "code": row.get("entry_source")}]
    return meta


def to_fhir(obj_or_cls: Any, row: Row | None = None) -> dict[str, Any]:
    """``to_fhir(orm_obj)`` or ``to_fhir(Model, SnapshotRow(snapshot))``."""
    if row is None:
        cls, row = type(obj_or_cls), OrmRow(obj_or_cls)
    else:
        cls = obj_or_cls
    body = serialize_row(cls, row)
    resource = {"resourceType": cls.fhir_type, "id": str(row.get("id")), "meta": _meta(cls, row)}
    extra = row.get("extension") or []
    resource.update(body)
    if extra:
        resource["extension"] = resource.get("extension", []) + list(extra)
    return resource


# --------------------------------------------------------------------------- hooks
def _patient_hook(row: Row, out: dict[str, Any]) -> None:
    """US Core race / ethnicity extensions from patient_race_ethnicity rows."""
    kids = row.children("race_ethnicity", "patient_race_ethnicity", "patient_id")
    for kind, text_col in (("race", "ext_race_text"), ("ethnicity", "ext_ethnicity_text")):
        mine = [k for k in kids if k.get("kind") == kind]
        if not mine:
            continue
        parts = [{"url": k.get("level"),
                  "valueCoding": _clean({"system": systems.RACE_ETHNICITY, "code": k.get("code"),
                                         "display": k.get("display")})} for k in mine]
        text = row.get(text_col) or ", ".join(k.get("display") or k.get("code") for k in mine)
        parts.append({"url": "text", "valueString": text})
        out.setdefault("extension", []).append(
            {"url": f"{US_CORE}/us-core-{kind}", "extension": parts})


def _provenance_hook(row: Row, out: dict[str, Any]) -> None:
    ref = f"{row.get('target_resource_type')}/{row.get('target_id')}"
    if row.get("target_version_id"):
        ref += f"/_history/{row.get('target_version_id')}"
    out["target"] = [{"reference": ref}]


def _provenance_entity_hook(row: Row, out: dict[str, Any]) -> None:
    ref = f"{row.get('what_resource_type')}/{row.get('what_id')}"
    if row.get("what_version_id"):
        ref += f"/_history/{row.get('what_version_id')}"
    out["what"] = {"reference": ref}


MAPPERS["patient"].fhir_hook = staticmethod(_patient_hook)
MAPPERS["provenance"].fhir_hook = staticmethod(_provenance_hook)
MAPPERS["provenance_entity"].fhir_hook = staticmethod(_provenance_entity_hook)
