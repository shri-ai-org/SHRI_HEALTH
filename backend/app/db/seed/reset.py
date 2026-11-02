"""``python -m app.db.seed reset``: an empty demo database to the demo setup data (plan §8,
Fri 13 Nov), synthetic patients only.

The reset has two halves. Dropping and recreating the database, with its database-level setup
(the service roles' CONNECT, ``00_extensions.sql`` as the master user), is Thulasi's reset split
(infra). This half runs after it, on that empty database, as ``shri_migrator``:

1. refuse anything but development or test (core's ``ENVIRONMENT``), and any database that
   already has tables in ``admin`` or ``clinical``: this never drops, truncates or deletes;
2. migrate to head (Alembic, ``MIGRATION_DATABASE_URL``);
3. load the ``demo`` layer (which loads ``starter`` first) in one transaction;
4. check the result and print a short summary: the migration head, and the demo clinic's
   patients and appointments, read inside that clinic as row-level security requires.

The audit protections are never disabled or bypassed. The demo users linked to Keycloak are
added here once Thulasi's realm has them.
"""
from __future__ import annotations

import pathlib
from dataclasses import dataclass

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A
from app.db.seed.demo import PATIENTS, load_demo
from app.db.seed.starter import require_dev_environment

ALEMBIC_INI = pathlib.Path(__file__).resolve().parents[1] / "alembic.ini"


class NotEmpty(RuntimeError):
    """The database already has tables: the reset only fills an empty one."""


@dataclass(frozen=True)
class ResetSummary:
    head: str
    patients: int
    appointments: int


def require_empty(engine: Engine) -> None:
    with engine.connect() as c:
        tables = c.execute(text(
            "SELECT count(*) FROM pg_tables WHERE schemaname IN ('admin', 'clinical')"
        )).scalar_one()
    if tables:
        raise NotEmpty("the database already has tables; the reset only fills an empty "
                       "database (recreate it first, with the reset split)")


def migrate() -> None:
    command.upgrade(Config(str(ALEMBIC_INI)), "head")


def summary(db: Session) -> ResetSummary:
    """Read in the demo clinic (CLINIC_A), as the seed writes it."""
    head = db.execute(text("SELECT version_num FROM admin.alembic_version")).scalar_one()
    db.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": str(CLINIC_A)})
    return ResetSummary(
        head=head,
        patients=db.execute(text("SELECT count(*) FROM clinical.patient")).scalar_one(),
        appointments=db.execute(text("SELECT count(*) FROM clinical.appointment")).scalar_one())


def reset(engine: Engine) -> ResetSummary:
    """Steps 1 to 4 (module docstring); the caller makes the engine as shri_migrator."""
    require_dev_environment()
    require_empty(engine)
    migrate()
    with Session(engine) as db, db.begin():
        load_demo(db)
    with Session(engine) as db, db.begin():
        found = summary(db)
    if found.patients < len(PATIENTS):
        raise RuntimeError(f"the demo layer loaded {found.patients} patients, "
                           f"expected {len(PATIENTS)}")
    return found
