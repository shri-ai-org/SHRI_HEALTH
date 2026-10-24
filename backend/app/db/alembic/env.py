"""Alembic environment. Migrations run as shri_migrator (table owner), never as shri_app.

The connection comes from the core's settings (app/core/config.py): MIGRATION_DATABASE_URL,
the one URL per service role that D23 reserves for shri_migrator. Migrations are synchronous,
so the driver is always psycopg v3 whatever driver name the configured URL carries (agreed
with Thulasi, 2026-10-24).
"""
from __future__ import annotations

from logging.config import fileConfig
from typing import Any

from alembic import context
from sqlalchemy import create_engine, pool
from sqlalchemy.engine import make_url

import app.db.models  # noqa: F401  (registers tables + generated constraints)
from app.core.config import get_settings
from app.db.base import ADMIN_SCHEMA, AUDIT_SCHEMA, CLINICAL_SCHEMA, Base

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

SYNC_DRIVER = "postgresql+psycopg"


def migration_url() -> str:
    secret = get_settings().migration_database_url
    if secret is None:
        raise RuntimeError("MIGRATION_DATABASE_URL is not configured (the shri_migrator login)")
    url = make_url(secret.get_secret_value())
    return url.set(drivername=SYNC_DRIVER).render_as_string(hide_password=False)


URL = migration_url()
target_metadata = Base.metadata

#: The three data schemas (D23). Only these are compared by `alembic check`.
DATA_SCHEMAS = frozenset({CLINICAL_SCHEMA, ADMIN_SCHEMA, AUDIT_SCHEMA})

# Why the migration connection pins search_path to `public` only:
#
# shri_migrator's role search_path is `clinical, admin, audit, public` (sql/00_extensions.sql),
# which is convenient for running SQL by hand but makes `alembic check` compare the wrong
# things, in two ways, both documented SQLAlchemy/Alembic behaviour:
#   1. the "default" schema (None) reflects as every table *visible* through the search_path,
#      so all three data schemas came back a second time with no schema name and matched
#      nothing in the models, while Alembic dropped current_schema() (`clinical`) from the
#      explicit list, so clinical tables were never compared under their real name;
#   2. a reflected foreign key omits its referred schema whenever that schema is on the
#      search_path (postgresql_ignore_search_path=False), so every cross-schema FK
#      (`admin.x -> clinical.y`) differed from the model's `clinical.y.id`.
# Together: thousands of spurious add/remove lines, the "false drift" noted on issue #13.
#
# With search_path = public: current_schema() holds no tables, so no data schema is dropped;
# include_name below skips the default-schema reflection; and no data schema is on the path,
# so every referred schema is reflected explicitly. Each data schema is then compared once,
# under its own name, exactly as the models declare it. The migrations themselves do not
# depend on the search_path - every CREATE/ALTER/GRANT in the frozen SQL is schema-qualified
# (sql_0001/, sql_0002/), which a fresh downgrade/upgrade on this connection proves.
SEARCH_PATH = "public"


def include_name(name: str | None, type_: str, parent_names: Any) -> bool:
    if type_ == "schema":
        return name in DATA_SCHEMAS  # None (the default schema) and anything else: skipped
    return True


def include_object(obj: Any, name: str | None, type_: str, reflected: bool,
                   compare_to: Any) -> bool:
    # pgvector / tsvector index details and expression indexes are not compared reliably.
    return not (type_ == "index" and name is not None
                and name.startswith(("ix_knowledge_chunk_",)))


def _configure(**kwargs: Any) -> None:
    context.configure(target_metadata=target_metadata, compare_type=True,
                      include_schemas=True, include_name=include_name,
                      include_object=include_object, version_table_schema=ADMIN_SCHEMA,
                      **kwargs)


def run_migrations_offline() -> None:
    _configure(url=URL, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(URL, poolclass=pool.NullPool,
                           connect_args={"options": f"-c search_path={SEARCH_PATH}"})
    with engine.connect() as connection:
        _configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
