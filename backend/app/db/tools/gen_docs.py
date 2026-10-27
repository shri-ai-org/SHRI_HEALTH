"""Generate backend/app/db/docs/data_dictionary.md from the models and the contract.

One section per table, ordered by schema and then name: what the table is, its columns (type,
nullability, FHIR element, foreign-key targets, contract name), its constraints, and, for a FHIR
resource table, its child tables.

Contract names come from two sources and are never guessed:
- contracts/docs/DATA_OWNERSHIP.md, section 2: which tables store each contract resource. Only rows
  whose "Tables" cell names tables of this schema in backticks count. Every other resource row
  (a FHIR resource name instead of tables, "pending schema lock", or a section with no Tables
  column) is listed at the end as not yet mapped, with what the document says.
- contracts/openapi/dist/shri-health.bundled.yaml: the property names of those resources'
  operations (request bodies and 2xx response bodies, top level, list envelopes unwrapped).
A column's contract name is its camelCase form (D20) when one of those properties has that name.

The "Contract to column mapping" section lists, for each resource, every contract property and
where it is stored: a same-named column, or the hand-written override in
docs/contract_mapping.yaml (for pairs a generator cannot infer, and computed properties), or
"not mapped yet". The generator stops if the override names anything that does not exist.

The output is deterministic (everything sorted, or in declaration order), so regenerating it never
produces a noisy diff.

Usage:  python -m app.db.tools.gen_docs
"""
from __future__ import annotations

import pathlib
import re
from dataclasses import dataclass
from typing import Any

import yaml  # type: ignore[import-untyped]
from sqlalchemy import CheckConstraint, Column, ForeignKeyConstraint, Table, UniqueConstraint

from app.db.constraints import patient_column, referenced_table
from app.db.models import GLOBAL_TABLES, MAPPERS

ROOT = pathlib.Path(__file__).resolve().parents[1]          # backend/app/db
REPO = pathlib.Path(__file__).resolve().parents[4]          # repository root
OWNERSHIP = REPO / "contracts/docs/DATA_OWNERSHIP.md"
CONTRACT = REPO / "contracts/openapi/dist/shri-health.bundled.yaml"
OUTPUT = ROOT / "docs/data_dictionary.md"
OVERRIDES = ROOT / "docs/contract_mapping.yaml"
METHODS = ("get", "post", "put", "patch", "delete")
ENVELOPE = {"items", "nextCursor"}


@dataclass(frozen=True)
class Resource:
    section: str
    name: str
    paths: tuple[str, ...]
    tables: tuple[str, ...]       # empty when DATA_OWNERSHIP.md does not map it to tables
    says: str                     # the "Tables" cell, verbatim, or why there is none


def camel(name: str) -> str:
    first, *rest = name.split("_")
    return first + "".join(part[:1].upper() + part[1:] for part in rest)


def _doc(cls: type[Any]) -> str:
    return " ".join((cls.__doc__ or "").strip().split("\n\n")[0].split())


def _kind(name: str, cls: type[Any]) -> str:
    if getattr(cls, "fhir_type", None):
        return f"FHIR resource `{cls.fhir_type}`"
    if hasattr(cls, "fhir_parent"):
        return "FHIR child / datatype table"
    if name in GLOBAL_TABLES:
        return "Admin, platform-wide"
    return "Admin (normalized)"


def _fhir(col: Any) -> str:
    info = col.info
    if "owner" in info:
        return f"owner → {info['owner']}"
    if info.get("parent"):
        return "parent"
    if "fhir_ext" in info:
        return f"extension `{info['fhir_ext'].rsplit('/', 1)[-1]}`"
    if "fhir" not in info:
        return ""
    s = f"`{info['fhir']}`"
    if info.get("part"):
        s += f".{info['part']}"
    if info.get("fixed_system"):
        s += " (fixed system)"
    if info.get("many"):
        s += " [0..*]"
    return s


def _cell(text: str) -> str:
    return " ".join(text.replace("|", "\\|").split())


# --------------------------------------------------------------------------- contract sources
def ownership() -> list[Resource]:
    """Section 2 resource rows of DATA_OWNERSHIP.md, in document order."""
    out: list[Resource] = []
    section = ""
    lines = OWNERSHIP.read_text().splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("### 2."):
            section = line.lstrip("# ").strip()
        if line.startswith("| Resource |"):
            header = [c.strip() for c in line.strip().strip("|").split("|")]
            has_tables = header[-1].startswith("Tables")
            i += 2                                        # skip the header separator
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                paths = tuple(p for p in re.findall(r"`(/[^`]+)`", cells[1]))
                if not has_tables:
                    out.append(Resource(section, cells[0], paths, (),
                                        "no Tables column in this section"))
                else:
                    # Only the first part of the cell: after a ";" come cross-references
                    # ("payers in Ad (`payer`, `practice_payer`)"), not this resource's tables.
                    own = cells[-1].split(";", 1)[0]
                    named = tuple(t for t in re.findall(r"`([a-z_]+)`", own) if t in MAPPERS)
                    pending = "pending schema lock" in cells[-1]
                    out.append(Resource(section, cells[0], paths, () if pending else named,
                                        cells[-1]))
                i += 1
            continue
        i += 1
    return out


class Contract:
    """Top-level property names of each path's request and 2xx response bodies."""

    def __init__(self) -> None:
        bundle = yaml.safe_load(CONTRACT.read_text())
        self.paths: dict[str, Any] = bundle.get("paths", {})
        self.schemas: dict[str, Any] = bundle.get("components", {}).get("schemas", {})

    def _resolve(self, schema: Any) -> dict[str, Any]:
        while isinstance(schema, dict) and "$ref" in schema:
            schema = self.schemas.get(schema["$ref"].rsplit("/", 1)[-1], {})
        return schema if isinstance(schema, dict) else {}

    def _names(self, schema: Any, depth: int = 0) -> set[str]:
        schema = self._resolve(schema)
        names: set[str] = set()
        if depth > 6:
            return names
        for key in ("allOf", "oneOf", "anyOf"):
            for part in schema.get(key, []):
                names |= self._names(part, depth + 1)
        if schema.get("type") == "array":
            names |= self._names(schema.get("items"), depth + 1)
        props = schema.get("properties", {})
        items = self._resolve(props.get("items")) if "items" in props else {}
        if items.get("type") == "array":              # a list envelope: { items, nextCursor }
            names |= self._names(items.get("items"), depth + 1)
            names |= set(props) - ENVELOPE
        else:
            names |= set(props)
        return names

    def properties(self, path: str) -> set[str] | None:
        """None when the path is not in the contract."""
        item = self.paths.get(path)
        if not isinstance(item, dict):
            return None
        names: set[str] = set()
        for method in METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue
            bodies = [op.get("requestBody", {})]
            bodies += [r for code, r in op.get("responses", {}).items()
                       if str(code).startswith("2")]
            for body in bodies:
                for media, content in self._resolve(body).get("content", {}).items():
                    if media.endswith("json") and "problem" not in media:
                        names |= self._names(content.get("schema"))
        return names


def overrides(resources: list[Resource], contract: Contract) -> dict[str, dict[str, Any]]:
    """docs/contract_mapping.yaml, checked: every resource, property, table and column it
    names must exist, so the file cannot drift from the schema or the contract."""
    data = yaml.safe_load(OVERRIDES.read_text()) or {}
    by_name = {r.name: r for r in resources}
    for rname, props in data.items():
        if rname not in by_name:
            raise ValueError(f"{OVERRIDES.name}: {rname!r} is not a DATA_OWNERSHIP.md resource")
        known = _properties(by_name[rname], contract)
        for prop, entry in props.items():
            source: set[str] | None = known
            if entry.get("path"):              # a property of another operation, e.g. check-in
                source = contract.properties(entry["path"])
            if source is None:
                raise ValueError(f"{OVERRIDES.name}: {rname}.{prop}: no contract path "
                                 f"{entry['path']!r}")
            if prop.split("[]", 1)[0] not in source:
                raise ValueError(f"{OVERRIDES.name}: {rname}: no contract property {prop!r}")
            if not entry.get("columns") and not entry.get("computed"):
                raise ValueError(f"{OVERRIDES.name}: {rname}.{prop} needs columns or computed")
            for ref in entry.get("columns", []):
                table, _, column = ref.partition(".")
                if table not in MAPPERS or column not in MAPPERS[table].__table__.c:
                    raise ValueError(f"{OVERRIDES.name}: {rname}.{prop}: no column {ref}")
    return data


def _properties(resource: Resource, contract: Contract) -> set[str]:
    found: set[str] = set()
    for path in resource.paths:
        found |= contract.properties(path) or set()
    return found


def _mapping_section(resources: list[Resource], contract: Contract) -> list[str]:
    table_of = overrides(resources, contract)
    out = ["## Contract to column mapping", "",
           "For each resource: every contract property and where it is stored (D20). "
           "**same name**: the column of the resource's own (first) table with the property's "
           "name in snake_case. **mapped** and "
           "**computed**: from `docs/contract_mapping.yaml`, hand-written. **not mapped yet**: "
           "the module's repository has to decide; add it to the override file.", ""]
    for r in resources:
        extra = table_of.get(r.name, {})
        if not r.tables and not extra:
            continue
        props = _properties(r, contract)
        out += [f"### {_cell(r.name)}", ""]
        if r.paths:
            out += ["Paths: " + ", ".join(f"`{p}`" for p in r.paths), ""]
        out += ["| Property | Stored in | How |", "|---|---|---|"]
        for prop in sorted(props) + sorted(p for p in extra if p not in props):
            entry = extra.get(prop)
            if entry is not None:
                cols = ", ".join(f"`{c}`" for c in entry.get("columns", [])) or "—"
                how = (f"computed: {entry['computed']}" if entry.get("computed")
                       else "mapped" + (f": {entry['note']}" if entry.get("note") else ""))
                if entry.get("computed") and entry.get("note"):
                    how += f"; {entry['note']}"
                if entry.get("path"):
                    how += f" (from `{entry['path']}`)"
                out.append(f"| `{prop}` | {cols} | {_cell(how)} |")
                continue
            # The resource's own (first) table only: a same-named column of a child table is
            # often something else (coverage_payor.patient_id is a payor, not the patient).
            root = r.tables[0] if r.tables else None
            same = [f"{root}.{c.name}" for c in MAPPERS[root].__table__.columns
                    if camel(c.name) == prop] if root else []
            if same:
                out.append(f"| `{prop}` | `{same[0]}` | same name |")
            else:
                out.append(f"| `{prop}` | — | not mapped yet |")
        out.append("")
    return out


# --------------------------------------------------------------------------- rendering
def _references(col: Column[Any]) -> str:
    targets = sorted({f"{fk.column.table.schema}.{fk.column.table.name}.{fk.column.name}"
                      for fk in col.foreign_keys})
    return ", ".join(targets)


def _constraint_names(table: Table, kind: type, composite_fk: bool = False) -> list[str]:
    return sorted(str(c.name) for c in table.constraints
                  if isinstance(c, kind) and c.name
                  and (not composite_fk or len(c.columns) > 1))   # type: ignore[attr-defined]


def _table_section(name: str, cls: type[Any], children: dict[str, list[str]],
                   resources: list[Resource], contract: Contract) -> list[str]:
    table: Table = cls.__table__
    out = [f"## `{table.schema}.{name}`", "", f"{_kind(name, cls)}. {_doc(cls)}".rstrip(), ""]
    pcol = patient_column(table)
    if pcol is not None:
        out += [f"Patient-owned via `{pcol.name}` (same-patient foreign keys apply).", ""]
    kids = sorted(children.get(name, []))
    if kids:
        out += ["Child tables: " + ", ".join(f"`{MAPPERS[k].__table__.schema}.{k}`"
                                             for k in kids), ""]

    mine = [r for r in resources if name in r.tables]
    props: set[str] = set()
    missing_paths: list[str] = []
    if mine:
        out.append("Contract (from DATA_OWNERSHIP.md):")
        for r in mine:
            out.append(f"- {r.name}: " + ", ".join(f"`{p}`" for p in r.paths))
            for p in r.paths:
                found = contract.properties(p)
                if found is None:
                    missing_paths.append(p)
                else:
                    props |= found
        out.append("")
        if missing_paths:
            out += ["Paths named in DATA_OWNERSHIP.md but not in the bundled contract: "
                    + ", ".join(f"`{p}`" for p in sorted(set(missing_paths))), ""]
    else:
        out += ["Contract: not mapped to a contract resource in DATA_OWNERSHIP.md.", ""]

    out += ["| Column | Type | Null | FHIR | References | Contract name |",
            "|---|---|---|---|---|---|"]
    matched: set[str] = set()
    for col in table.columns:
        if not mine:
            contract_name = "—"
        elif camel(col.name) in props:
            contract_name = f"`{camel(col.name)}`"
            matched.add(camel(col.name))
        else:
            contract_name = "no same-named property"
        out.append(f"| `{col.name}` | {_cell(str(col.type).lower())} | "
                   f"{'yes' if col.nullable else 'no'} | {_fhir(col)} | {_references(col)} | "
                   f"{contract_name} |")
    if mine:
        unmatched = sorted(props - matched)
        out += ["", "Contract properties with no column of the same name: "
                + (", ".join(f"`{p}`" for p in unmatched) if unmatched else "none")]

    checks = _constraint_names(table, CheckConstraint)
    uniques = _constraint_names(table, UniqueConstraint)
    composite = _constraint_names(table, ForeignKeyConstraint, composite_fk=True)
    if checks:
        out += ["", "Checks: " + ", ".join(f"`{c}`" for c in checks)]
    if uniques:
        out += ["", "Unique: " + ", ".join(f"`{c}`" for c in uniques)]
    if composite:
        out += ["", "Composite foreign keys: " + ", ".join(f"`{c}`" for c in composite)]
    out.append("")
    return out


def data_dictionary() -> str:
    resources = ownership()
    contract = Contract()
    children: dict[str, list[str]] = {}
    for name, cls in MAPPERS.items():
        for col in getattr(cls, "fhir_parent", ()):
            children.setdefault(referenced_table(cls.__table__.c[col]).name, []).append(name)

    out = ["# Data dictionary", "",
           "Generated by `python -m app.db.tools.gen_docs` from the SQLAlchemy models, "
           "`contracts/docs/DATA_OWNERSHIP.md` and "
           "`contracts/openapi/dist/shri-health.bundled.yaml`. "
           "Do not edit by hand: regenerate it.", "",
           "- **FHIR**: the FHIR element a column stores. Columns that share an element form one "
           "value. `ext_*` columns are Shri extensions.",
           "- **Contract name**: the column's camelCase name (D20) when an operation of a contract "
           "resource stored in this table has a property of that name. Where a table is not yet "
           "mapped to a resource in DATA_OWNERSHIP.md, it shows \"—\"; where it is mapped but no "
           "property has the column's name, the module's repository maps the name itself.",
           "- Only top-level contract properties are compared: a nested object (a patient's "
           "`name`, say) counts as one property, so its child table's columns show no "
           "same-named property.",
           "- Resources that DATA_OWNERSHIP.md does not yet map to tables are listed in the last "
           "section, with what the document says.", ""]
    ordered = sorted(MAPPERS.items(), key=lambda kv: (str(kv[1].__table__.schema), kv[0]))
    for name, cls in ordered:
        out += _table_section(name, cls, children, resources, contract)

    out += _mapping_section(resources, contract)
    out += ["## Contract resources not yet mapped to tables", "",
            "DATA_OWNERSHIP.md does not name tables for these yet. They are not guessed here.", ""]
    section = None
    for r in resources:
        if r.tables:
            continue
        if r.section != section:
            section = r.section
            out += ["", f"### {section}", ""]
        paths = ", ".join(f"`{p}`" for p in r.paths) or "no path"
        out.append(f"- **{_cell(r.name)}** ({paths}): {_cell(r.says)}")
    return "\n".join(out).replace("\n\n\n", "\n\n").rstrip("\n") + "\n"


def main() -> None:
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(data_dictionary())
    print(f"wrote {OUTPUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
