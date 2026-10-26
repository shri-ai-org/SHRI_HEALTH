"""Shri Health OpenEMR Edition - SQLAlchemy 2 models.

``app.db.models.fhir``  - clinical data as FHIR R4 / US Core resources (one table per resource,
                        child tables for repeating elements).
``app.db.models.admin`` - non-clinical features as normalized tables.

Importing this package registers every table on ``Base.metadata`` and applies the generated
constraints (``constraints.py``), so Alembic and the API see the same schema.
"""
from typing import Any

from app.db.base import Base
from app.db.constraints import apply_all as _apply_constraints

from . import enums, systems  # noqa: F401
from .admin import ai, comms, core, medication, orders, platform, practice, rcm  # noqa: F401
from .fhir import clinical, datatypes, directory, documents, records, workflow  # noqa: F401
from .fhir import medication as fhir_medication  # noqa: F401  (imported to register its tables)
from .fhir import orders as fhir_orders  # noqa: F401  (imported to register its tables)

# type[Any]: model classes are looked up by name at runtime, so their columns are not known to
# the type checker through these registries.
MAPPERS: dict[str, type[Any]] = {
    m.class_.__tablename__: m.class_ for m in Base.registry.mappers}
_apply_constraints(Base.metadata, MAPPERS)

# FHIR resource tables (have fhir_type) and their child tables.
FHIR_RESOURCES: dict[str, type[Any]] = {
    cls.fhir_type: cls for cls in MAPPERS.values() if getattr(cls, "fhir_type", None)}
FHIR_CHILD_TABLES: set[str] = {
    name for name, cls in MAPPERS.items() if hasattr(cls, "fhir_parent")}

# Tables without tenant_id (platform-wide reference data). Keyed by bare table name (t.name),
# not the metadata.tables dict key, which is schema-qualified ("admin.code_system") now that
# every table carries a schema (D23) - every other registry in this module (MAPPERS,
# FHIR_RESOURCES, FHIR_CHILD_TABLES) is bare-name-keyed too, so this stays consistent with them.
GLOBAL_TABLES = {t.name for t in Base.metadata.tables.values() if "tenant_id" not in t.c}
