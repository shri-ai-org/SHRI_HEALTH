"""Column factories for FHIR R4 datatypes.

Every column of a FHIR table carries ``info``:

  fhir        element name in FHIR camelCase, relative to the resource or backbone element
              (``code``, ``valueQuantity``, ``subject``, ``effectiveDateTime``)
  fhir_type   FHIR datatype (``CodeableConcept``, ``Quantity``, ``Reference``, ``dateTime`` ...)
  part        which part of a complex datatype the column holds (``system``, ``code`` ...)
  required    element is 1..1 (a presence CHECK is generated)
  ref_type    target resource type, for references
  fixed_system  CodeSystem URI of a required-binding CodeableConcept stored as a bare code

``shri.models.constraints`` turns this metadata into CHECK constraints (coding pairs, qty-3,
per-1, rng-2, exclusive reference arcs, choice-type ``[x]`` exclusivity) and
``shri.fhir.serializer`` turns rows back into FHIR JSON, so the two can never drift apart.

Usage (tuple-unpack so the column names stay visible in the model):

    code_system, code_code, code_display, code_text = cc("code", required=True)
"""
from __future__ import annotations

import enum
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import mapped_column

from .base import enum_type

CODE_SYSTEM_FK = "code_system.uri"
UCUM = "http://unitsofmeasure.org"
DECIMAL = Numeric(18, 6)


def _info(element: str, fhir_type: str, part: str | None = None, **extra: Any) -> dict:
    info = {"fhir": element, "fhir_type": fhir_type}
    if part:
        info["part"] = part
    info.update({k: v for k, v in extra.items() if v not in (None, False)})
    return info


# --------------------------------------------------------------------------- primitives
def prim(element: str, sa_type: Any, fhir_type: str, *, required: bool = False,
         **kw: Any) -> Any:
    """A FHIR primitive (string, boolean, dateTime, date, integer, decimal, markdown ...)."""
    return mapped_column(sa_type, nullable=not required,
                         info=_info(element, fhir_type, required=required), **kw)


def string(element: str, length: int | None = 500, *, required: bool = False, **kw: Any) -> Any:
    return prim(element, String(length) if length else Text, "string", required=required, **kw)


def markdown(element: str, *, required: bool = False) -> Any:
    return prim(element, Text, "markdown", required=required)


def boolean(element: str, *, required: bool = False, **kw: Any) -> Any:
    return prim(element, Boolean, "boolean", required=required, **kw)


def date_time(element: str, *, required: bool = False, **kw: Any) -> Any:
    return prim(element, DateTime(timezone=True), "dateTime", required=required, **kw)


def instant(element: str, *, required: bool = False, **kw: Any) -> Any:
    return prim(element, DateTime(timezone=True), "instant", required=required, **kw)


def fdate(element: str, *, required: bool = False, **kw: Any) -> Any:
    return prim(element, Date, "date", required=required, **kw)


def integer(element: str, *, required: bool = False, fhir_type: str = "integer",
            **kw: Any) -> Any:
    return prim(element, Integer, fhir_type, required=required, **kw)


def decimal(element: str, *, required: bool = False) -> Any:
    return prim(element, DECIMAL, "decimal", required=required)


def code(element: str, enum_cls: type[enum.Enum], *, required: bool = False,
         default: enum.Enum | None = None, length: int = 40) -> Any:
    """A FHIR ``code`` with a required binding: VARCHAR + CHECK on the value set."""
    kw: dict[str, Any] = {}
    if default is not None:
        kw = {"default": default.value, "server_default": default.value}
    return mapped_column(enum_type(enum_cls, length), nullable=not required,
                         info=_info(element, "code", required=required), **kw)


def code_list(element: str, *, fixed_system: str | None = None) -> Any:
    """0..* FHIR ``code`` as varchar[]; pair with ``base.code_array_check`` in __extra_args__.
    With ``fixed_system`` the element is a list of required-binding CodeableConcepts."""
    fhir_type = "CodeableConcept" if fixed_system else "code"
    return mapped_column(ARRAY(String(40)), nullable=False, default=list,
                         server_default=text("'{}'"),
                         info=_info(element, fhir_type, "code" if fixed_system else None,
                                    many=True, fixed_system=fixed_system))


# --------------------------------------------------------------------------- complex types
def cc(element: str, *, required: bool = False, system_fk: bool = True,
       code_length: int = 64, many: bool = False) -> tuple[Any, Any, Any, Any]:
    """CodeableConcept with one coding: (system, code, display, text).

    ``system`` references ``code_system.uri`` so only registered code systems are stored.
    Extra codings (translations) go in the resource's ``*_coding`` child table where modelled.
    """
    sys_args: list[Any] = [ForeignKey(CODE_SYSTEM_FK, onupdate="CASCADE")] if system_fk else []
    return (
        mapped_column(String(300), *sys_args,
                      info=_info(element, "CodeableConcept", "system", required=required,
                                 many=many)),
        mapped_column(String(code_length), info=_info(element, "CodeableConcept", "code")),
        mapped_column(String(500), info=_info(element, "CodeableConcept", "display")),
        mapped_column(String(1000), info=_info(element, "CodeableConcept", "text")),
    )


def cc_code(element: str, enum_cls: type[enum.Enum], system: str, *, required: bool = False,
            default: enum.Enum | None = None) -> Any:
    """Required-binding CodeableConcept (e.g. Condition.clinicalStatus) stored as its code;
    the system is fixed and re-attached by the serializer."""
    kw: dict[str, Any] = {}
    if default is not None:
        kw = {"default": default.value, "server_default": default.value}
    return mapped_column(enum_type(enum_cls), nullable=not required,
                         info=_info(element, "CodeableConcept", "code", required=required,
                                    fixed_system=system), **kw)


def coding(element: str, *, required: bool = False, system_fk: bool = True,
           fixed_system: str | None = None, enum_cls: type[enum.Enum] | None = None,
           name: str | None = None) -> Any:
    """A single Coding. With ``fixed_system`` only the code column is stored."""
    if fixed_system:
        sa_type = enum_type(enum_cls) if enum_cls else String(64)
        args = (name, sa_type) if name else (sa_type,)
        return mapped_column(*args, nullable=not required,
                             info=_info(element, "Coding", "code", required=required,
                                        fixed_system=fixed_system))
    sys_args: list[Any] = [ForeignKey(CODE_SYSTEM_FK, onupdate="CASCADE")] if system_fk else []
    return (
        mapped_column(String(300), *sys_args,
                      info=_info(element, "Coding", "system", required=required)),
        mapped_column(String(64), info=_info(element, "Coding", "code")),
        mapped_column(String(500), info=_info(element, "Coding", "display")),
    )


def quantity(element: str, *, required: bool = False, comparator: bool = True,
             fhir_type: str = "Quantity") -> tuple[Any, ...]:
    """Quantity / Age / Duration / SimpleQuantity: (value, [comparator], unit, system, code)."""
    from shri.models.enums import QuantityComparator
    cols: list[Any] = [mapped_column(DECIMAL, info=_info(element, fhir_type, "value",
                                                         required=required))]
    if comparator:
        cols.append(mapped_column(enum_type(QuantityComparator, 2),
                                  info=_info(element, fhir_type, "comparator")))
    cols += [
        mapped_column(String(60), info=_info(element, fhir_type, "unit")),
        mapped_column(String(300), info=_info(element, fhir_type, "system")),
        mapped_column(String(60), info=_info(element, fhir_type, "code")),
    ]
    return tuple(cols)


def money(element: str, *, required: bool = False) -> tuple[Any, Any]:
    return (
        mapped_column(Numeric(12, 2), nullable=not required,
                      info=_info(element, "Money", "value", required=required)),
        mapped_column(String(3), nullable=False, default="USD", server_default="USD",
                      info=_info(element, "Money", "currency")),
    )


def period(element: str, *, required: bool = False) -> tuple[Any, Any]:
    return (
        mapped_column(DateTime(timezone=True),
                      info=_info(element, "Period", "start", required=required)),
        mapped_column(DateTime(timezone=True), info=_info(element, "Period", "end")),
    )


def date_period(element: str) -> tuple[Any, Any]:
    """Period whose bounds are dates (coverage, qualification): (start, end)."""
    return (
        mapped_column(Date, info=_info(element, "Period", "start")),
        mapped_column(Date, info=_info(element, "Period", "end")),
    )


def frange(element: str) -> tuple[Any, ...]:
    """Range: (low.value, low.unit, low.code, high.value, high.unit, high.code), UCUM units."""
    return (
        mapped_column(DECIMAL, info=_info(element, "Range", "low.value")),
        mapped_column(String(60), info=_info(element, "Range", "low.unit")),
        mapped_column(String(60), info=_info(element, "Range", "low.code")),
        mapped_column(DECIMAL, info=_info(element, "Range", "high.value")),
        mapped_column(String(60), info=_info(element, "Range", "high.unit")),
        mapped_column(String(60), info=_info(element, "Range", "high.code")),
    )


def identifier(element: str, *, required: bool = False) -> tuple[Any, Any]:
    """Single Identifier stored inline: (system, value)."""
    return (
        mapped_column(String(300), info=_info(element, "Identifier", "system")),
        mapped_column(String(200), nullable=not required,
                      info=_info(element, "Identifier", "value", required=required)),
    )


def attachment(element: str, *, required: bool = False) -> tuple[Any, Any, Any, Any]:
    """Attachment: bytes live in object storage (binary_object); (contentType, binary, title,
    creation). Size and SHA-256 come from binary_object."""
    return (
        mapped_column(String(100), info=_info(element, "Attachment", "contentType")),
        mapped_column(ForeignKey("binary_object.id", ondelete="RESTRICT"),
                      nullable=not required,
                      info=_info(element, "Attachment", "binary", required=required)),
        mapped_column(String(300), info=_info(element, "Attachment", "title")),
        mapped_column(DateTime(timezone=True), info=_info(element, "Attachment", "creation")),
    )


def ref(element: str, target_table: str, ref_type: str, *, required: bool = False,
        ondelete: str | None = "RESTRICT", index: bool = False, unique: bool = False,
        use_alter: bool = False, many: bool = False) -> Any:
    """Reference(ref_type) stored as a foreign key. Several ``ref`` columns with the same
    ``element`` form an exclusive arc (at most / exactly one set) - see constraints.py."""
    return mapped_column(
        ForeignKey(f"{target_table}.id", ondelete=ondelete, use_alter=use_alter),
        nullable=not required, index=index, unique=unique,
        info=_info(element, "Reference", required=required, ref_type=ref_type, many=many))


def ref_display(element: str) -> Any:
    """Reference.display for references to things outside this database."""
    return mapped_column(String(300), info=_info(element, "Reference", "display"))


def ref_identifier(element: str) -> tuple[Any, Any]:
    """Reference.identifier (logical reference, e.g. an outside NPI): (system, value)."""
    return (
        mapped_column(String(300), info=_info(element, "Reference", "identifier.system")),
        mapped_column(String(200), info=_info(element, "Reference", "identifier.value")),
    )


def owner(target_table: str, ref_type: str, *, ondelete: str = "CASCADE") -> Any:
    """Parent FK of a shared datatype table (identifier, human_name ...). The owner columns of
    one table form an exclusive arc: exactly one is set."""
    return mapped_column(ForeignKey(f"{target_table}.id", ondelete=ondelete), index=True,
                         info={"owner": ref_type})


def parent(target_table: str, *, ondelete: str = "CASCADE") -> Any:
    """FK from a backbone child row to its parent resource row."""
    return mapped_column(ForeignKey(f"{target_table}.id", ondelete=ondelete), nullable=False,
                         index=True, info={"parent": True})


def children(target: str, fk: str, element: str | None, *, order_by: str | None = None,
             spread: bool = False, single: bool = False) -> Any:
    """One-to-many relationship to a child table, exposed in FHIR as ``element`` (a list).

    ``spread=True``: each child row contributes its own elements to the parent (e.g. one
    encounter_reason row is either a reasonCode or a reasonReference entry).
    """
    from sqlalchemy.orm import relationship
    info: dict[str, Any] = {"fhir": element}
    if spread:
        info["spread"] = True
    if single:
        info["single"] = True      # 0..1 element stored in a child table
    return relationship(target, foreign_keys=f"{target}.{fk}", lazy="selectin",
                        cascade="all, delete-orphan", passive_deletes=True,
                        order_by=f"{target}.{order_by}" if order_by else None, info=info)
