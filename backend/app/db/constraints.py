"""Schema-wide constraints derived from the models, applied once after every table exists.

1. FHIR datatype rules, generated from column ``info`` (see ``app.db.fhir_types``):
   * Coding pairs: a code needs its system and vice versa; display needs a code.
   * qty-3 (unit code needs a system), comparator needs a value.
   * per-1 (Period start <= end), rng-2 (Range low <= high).
   * Required complex elements (e.g. ``code`` 1..1): at least code or text present.
   * Choice types ``[x]`` (``__fhir_choices__``): at most / exactly one option present.
   * Reference arcs: several FK columns for one element (Reference(A|B|C)) -> at most /
     exactly one set. Arc columns are made nullable here.
   * Shared datatype tables: exactly one owner column set.
2. Tenant-consistent FKs. FK checks bypass RLS, so a plain ``patient_id`` FK would let tenant
   A point at tenant B's row. Every FK between two tenant-scoped tables gets a composite
   ``(tenant_id, x_id) -> parent (tenant_id, id)`` FK backed by ``UNIQUE (tenant_id, id)``.
3. Patient-consistent FKs. A row that belongs to a patient may only reference rows of the same
   patient: ``(subject_patient_id, encounter_id) -> encounter (subject_patient_id, id)``.
   DEFERRABLE, so a patient merge can move a whole chart in one transaction.
4. AI provenance (FRS §3.4): a row recorded as AI-generated must point at the reviewed
   suggestion and name the verifying user.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, cast

from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKeyConstraint,
    MetaData,
    Table,
    UniqueConstraint,
)

MAX_IDENT = 63
PATIENT_ELEMENTS = {"subject", "patient", "beneficiary"}
PATIENT_COLUMNS = ("subject_patient_id", "patient_id", "beneficiary_patient_id")
# parts that never establish that an element is present on their own
NON_PRESENCE_PARTS = {"system", "display", "comparator", "unit", "currency", "contentType",
                      "title", "creation", "identifier.system", "low.unit", "low.code",
                      "high.unit", "high.code"}


def short_name(name: str) -> str:
    """PostgreSQL identifiers are capped at 63 bytes; keep long names unique with a hash."""
    if len(name) <= MAX_IDENT:
        return name
    digest = hashlib.sha1(name.encode(), usedforsecurity=False).hexdigest()  # a name, not a secret
    return f"{name[:MAX_IDENT - 9]}_{digest[:8]}"


def snake(element: str) -> str:
    element = element.replace(".", "_").replace("[x]", "")
    return re.sub(r"(?<!^)(?=[A-Z])", "_", element).lower()


def tenant_fk_name(table: str, column: str) -> str:
    return short_name(f"fk_{table}_{column}_tenant")


def tenant_uq_name(table: str) -> str:
    return short_name(f"uq_{table}_tenant_id_id")


def patient_fk_name(table: str, column: str) -> str:
    return short_name(f"fk_{table}_{column}_same_patient")


def patient_uq_name(table: str, patient_col: str) -> str:
    return short_name(f"uq_{table}_{patient_col}_id")


def _check(table: Table, sql: str, name: str) -> None:
    full = f"ck_{table.name}_{name}"
    if any(c.name in (name, full, short_name(full)) for c in table.constraints):
        return
    # pass the final (shortened) name so the naming convention is not applied twice
    from sqlalchemy.sql.elements import conv
    table.append_constraint(CheckConstraint(sql, name=conv(short_name(full))))


# --------------------------------------------------------------------------- 1. FHIR rules
def _groups(table: Table) -> dict[str, list[Any]]:
    groups: dict[str, list[Any]] = {}
    for col in table.columns:
        if col.info.get("fhir"):
            groups.setdefault(col.info["fhir"], []).append(col)
    return groups


def _presence(cols: list[Any]) -> str:
    keep = [c for c in cols if c.info.get("part") not in NON_PRESENCE_PARTS] or cols
    parts = []
    for c in keep:
        if c.info.get("many"):
            parts.append(f"cardinality({c.name}) > 0")
        else:
            parts.append(f"{_q(c.name)} IS NOT NULL")
    return "(" + " OR ".join(parts) + ")"


def _q(name: str) -> str:
    return f'"{name}"' if name in ("end", "order", "type", "class", "when", "date",
                                   "text") else name


def _part(cols: list[Any], part: str) -> Any:
    return next((c for c in cols if c.info.get("part") == part), None)


def apply_fhir_checks(metadata: MetaData, mappers: dict[str, type]) -> None:
    for table in metadata.tables.values():
        cls = mappers.get(table.name)
        groups = _groups(table)
        for el, cols in groups.items():
            ftype = cols[0].info.get("fhir_type")
            name = snake(el) if el != "." else "value"
            refs = [c for c in cols if ftype == "Reference" and c.foreign_keys]
            if ftype in ("CodeableConcept", "Coding"):
                sys_, code_, disp = _part(cols, "system"), _part(cols, "code"), _part(cols,
                                                                                      "display")
                if sys_ is not None and code_ is not None:
                    _check(table, f"({_q(code_.name)} IS NULL) = ({_q(sys_.name)} IS NULL)",
                           f"fhir_{name}_coding")
                if disp is not None and code_ is not None:
                    _check(table, f"{_q(disp.name)} IS NULL OR {_q(code_.name)} IS NOT NULL",
                           f"fhir_{name}_display")
            if ftype in ("Quantity", "Age", "Duration", "SimpleQuantity"):
                val, sys_, code_ = _part(cols, "value"), _part(cols, "system"), _part(cols, "code")
                comp = _part(cols, "comparator")
                if code_ is not None and sys_ is not None:
                    _check(table, f"{code_.name} IS NULL OR {sys_.name} IS NOT NULL",
                           f"fhir_{name}_qty_3")
                if comp is not None:
                    _check(table, f"{comp.name} IS NULL OR {val.name} IS NOT NULL",
                           f"fhir_{name}_comparator")
            if ftype == "Period":
                start, end = _part(cols, "start"), _part(cols, "end")
                if start is not None and end is not None:
                    _check(table, f"{_q(end.name)} IS NULL OR {_q(start.name)} IS NULL OR "
                                  f"{_q(start.name)} <= {_q(end.name)}", f"fhir_{name}_per_1")
            if ftype == "Range":
                lo, hi = _part(cols, "low.value"), _part(cols, "high.value")
                _check(table, f"{lo.name} IS NULL OR {hi.name} IS NULL OR {lo.name} <= {hi.name}",
                       f"fhir_{name}_rng_2")
            if len(refs) > 1:
                for c in refs:
                    c.nullable = True
                required = any(c.info.get("required") for c in refs)
                op = "= 1" if required else "<= 1"
                _check(table, f"num_nonnulls({', '.join(c.name for c in refs)}) {op}",
                       f"fhir_{name}_arc")
            required = any(c.info.get("required") for c in cols)
            if required and ftype not in ("Reference",) and (
                    len(cols) > 1 or cols[0].info.get("many")):
                _check(table, _presence(cols), f"fhir_{name}_required")

        for el, (required, options) in getattr(cls, "__fhir_choices__", {}).items():
            exprs = [f"({_presence(groups[o])})::int" for o in options if o in groups]
            missing = [o for o in options if o not in groups]
            if missing:
                raise RuntimeError(f"{table.name}: choice {el} has no columns for {missing}")
            _check(table, f"{' + '.join(exprs)} {'= 1' if required else '<= 1'}",
                   f"fhir_{snake(el)}_x")

        owners = [c for c in table.columns if "owner" in c.info]
        if owners:
            _check(table, f"num_nonnulls({', '.join(c.name for c in owners)}) = 1", "one_owner")


# --------------------------------------------------------------------------- 2. tenant FKs
def _tenant_scoped(table: Table) -> bool:
    col = table.c.get("tenant_id")
    return col is not None and not col.nullable


def apply_tenant_foreign_keys(metadata: MetaData) -> None:
    for table in sorted(metadata.tables.values(), key=lambda t: t.name):
        if not _tenant_scoped(table):
            continue
        for fk in sorted(table.foreign_keys, key=lambda f: f.parent.name):
            parent = fk.column.table
            if (len(cast(ForeignKeyConstraint, fk.constraint).columns) != 1
                    or fk.parent.name == "tenant_id"
                    or fk.column.name != "id" or not _tenant_scoped(parent)):
                continue
            uq = tenant_uq_name(parent.name)
            if not any(c.name == uq for c in parent.constraints):
                parent.append_constraint(UniqueConstraint("tenant_id", "id", name=uq))
            table.append_constraint(ForeignKeyConstraint(
                ["tenant_id", fk.parent.name], [parent.c.tenant_id, parent.c.id],
                name=tenant_fk_name(table.name, fk.parent.name), use_alter=True))


# --------------------------------------------------------------------------- 3. patient FKs
def patient_column(table: Table) -> Column[Any] | None:
    """The column that says which patient a row belongs to (None if not patient-owned)."""
    for name in PATIENT_COLUMNS:
        col = table.c.get(name)
        if col is None or "owner" in col.info:
            continue
        el = col.info.get("fhir")
        if el is None or el in PATIENT_ELEMENTS:
            return col
    return None


def referenced_table(column: Column[Any]) -> Table:
    """The table a parent or reference column points at.

    A column can belong to several foreign keys: its own, the clinic-carrying composite key
    (tenant_id, x_id) and same-patient composite keys (patient_id, x_id) that
    apply_tenant_foreign_keys and apply_patient_foreign_keys add. ``column.foreign_keys`` is a
    set, so taking any one of its members depends on hash order and can name the wrong table.
    The table the column refers to is the target of the key whose referenced column is ``id``;
    there is exactly one (tests/test_generators.py checks every parent and reference column).
    """
    targets = {fk.column.table for fk in column.foreign_keys if fk.column.name == "id"}
    if len(targets) != 1:
        found = sorted(target.name for target in targets)
        raise ValueError(f"{column.table.name}.{column.name}: expected one referenced table, "
                         f"found {found}")
    return next(iter(targets))


def apply_patient_foreign_keys(metadata: MetaData) -> None:
    for table in sorted(metadata.tables.values(), key=lambda t: t.name):
        pcol = patient_column(table)
        if pcol is None:
            continue
        for fk in sorted(table.foreign_keys, key=lambda f: f.parent.name):
            parent = fk.column.table
            ppcol = patient_column(parent)
            if (ppcol is None or fk.parent is pcol
                    or len(cast(ForeignKeyConstraint, fk.constraint).columns) != 1
                    or fk.column.name != "id" or fk.parent.name == "tenant_id"):
                continue
            uq = patient_uq_name(parent.name, ppcol.name)
            if not any(c.name == uq for c in parent.constraints):
                parent.append_constraint(UniqueConstraint(ppcol.name, "id", name=uq))
            table.append_constraint(ForeignKeyConstraint(
                [pcol.name, fk.parent.name], [ppcol, parent.c.id],
                name=patient_fk_name(table.name, fk.parent.name), use_alter=True,
                deferrable=True, initially="IMMEDIATE"))


# --------------------------------------------------------------------------- 4. AI provenance
def apply_ai_provenance_checks(metadata: MetaData) -> None:
    for table in metadata.tables.values():
        if {"entry_source", "ai_suggestion_id", "verified_by_user_id"} <= set(table.c.keys()):
            _check(table, "entry_source <> 'ai-generated' OR "
                          "(ai_suggestion_id IS NOT NULL AND verified_by_user_id IS NOT NULL)",
                   "ai_entry_verified")


# --------------------------------------------------------------------------- 5. enum values
def apply_enum_checks(metadata: MetaData) -> None:
    from sqlalchemy import Enum as SAEnum
    for table in metadata.tables.values():
        for col in table.columns:
            if isinstance(col.type, SAEnum) and not col.type.native_enum:
                values = ", ".join("'" + v.replace("'", "''") + "'" for v in col.type.enums)
                _check(table, f"{_q(col.name)} IN ({values})", f"{col.name}_codes")


def apply_all(metadata: MetaData, mappers: dict[str, type]) -> None:
    if metadata.info.get("shri_constraints_applied"):
        return
    apply_enum_checks(metadata)
    apply_fhir_checks(metadata, mappers)
    apply_tenant_foreign_keys(metadata)
    apply_patient_foreign_keys(metadata)
    apply_ai_provenance_checks(metadata)
    metadata.info["shri_constraints_applied"] = True
