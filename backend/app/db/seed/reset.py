"""``python -m app.db.seed reset``: an empty demo database to the demo setup data (plan §8,
Fri 13 Nov), synthetic patients only.

The reset has two halves. Dropping and recreating the database, with its database-level setup
(the service roles' CONNECT, ``00_extensions.sql`` as the master user), is Thulasi's reset split
(infra). This half runs after it, on that empty database, as ``shri_migrator``:

1. refuse anything but development or test (core's ``ENVIRONMENT``), and any database that
   already has tables in ``admin`` or ``clinical``: this never drops, truncates or deletes;
2. migrate to head (Alembic, ``MIGRATION_DATABASE_URL``);
3. load the ``demo`` layer (which loads ``starter`` first) in one transaction;
4. load the demo patients' clinical history (``history.py``) in a second one;
5. check the result and print a short summary: the migration head, and the demo clinic's
   patients and appointments, read inside that clinic as row-level security requires. The
   reset fails (a non-zero exit and one line) unless the clinic has at least 512 patients, its
   zone is America/Los_Angeles, both AI features are on, at least 6 visits are booked on the
   demo day, the four portal accounts are on their charts and the MRN counter answers.

The audit protections are never disabled or bypassed. The demo users linked to Keycloak are
added here once Thulasi's realm has them.
"""
from __future__ import annotations

import pathlib
from dataclasses import dataclass
from typing import Any

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A, FACILITY_A
from app.db.seed import history, starter
from app.db.seed.demo import (
    CLINIC_ZONE,
    DEMO_DAY,
    DEMO_PATIENT_SUBJECT,
    DEMO_PORTAL_PATIENT,
    PATIENT,
    PATIENTS,
    PORTAL_USERS,
    load_demo,
    population,
)
from app.db.seed.starter import require_dev_environment, sid

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
    """Steps 1 to 5 (module docstring); the caller makes the engine as shri_migrator."""
    require_dev_environment()
    require_empty(engine)
    migrate()
    with Session(engine) as db, db.begin():
        load_demo(db)
    history.run(engine)
    with Session(engine) as db, db.begin():
        found = summary(db)
        problems = verify(db, found)
    if problems:
        raise RuntimeError("reset check failed: " + "; ".join(problems))
    return found


#: What the demo needs after every reset (Vimal's review of #329), checked inside the demo clinic.
MIN_VISITS_TODAY = 6
AI_FEATURES = ("ambient-documentation", "chart-summary")


def verify(db: Session, found: ResetSummary) -> list[str]:
    """Each way the reset left the demo unusable, as one short phrase; empty when all is well.
    Runs in the summary's transaction, with the demo clinic set."""
    problems = []
    expected = len(PATIENTS) + len(population())
    if found.patients < expected:
        problems.append(f"{found.patients} patients, expected at least {expected}")
    zone = db.execute(text("SELECT t.timezone, f.timezone FROM admin.tenant t, admin.facility f "
                           "WHERE t.id = :t AND f.id = :f"),
                      {"t": CLINIC_A, "f": FACILITY_A}).one()
    if tuple(zone) != (CLINIC_ZONE.key, CLINIC_ZONE.key):
        problems.append(f"the clinic's time zone is {zone[0]} (main office {zone[1]}), "
                        f"expected {CLINIC_ZONE.key}")
    on = set(db.execute(text("SELECT feature FROM admin.ai_feature_setting WHERE tenant_id = :t "
                             "AND is_enabled"), {"t": CLINIC_A}).scalars())
    if off := [f for f in AI_FEATURES if f not in on]:
        problems.append(f"AI feature not on: {', '.join(off)}")
    today = db.execute(text(
        "SELECT count(*) FROM clinical.appointment WHERE status = 'booked' "
        "AND (start AT TIME ZONE :zone)::date = :day"),
        {"zone": CLINIC_ZONE.key, "day": DEMO_DAY}).scalar_one()
    if today < MIN_VISITS_TODAY:
        problems.append(f"{today} visits booked on the demo day {DEMO_DAY}, expected at least "
                        f"{MIN_VISITS_TODAY}")
    accounts: dict[str, Any] = {r.subject: r.patient_id for r in db.execute(text(
        "SELECT keycloak_user_id::text AS subject, patient_id FROM admin.portal_account "
        "WHERE status = 'active'"))}
    wanted = {DEMO_PATIENT_SUBJECT: DEMO_PORTAL_PATIENT,
              **{subject: patient for _, patient, _, subject in PORTAL_USERS}}
    if missing := [s for s, n in wanted.items() if accounts.get(s) != sid(PATIENT, n)]:
        problems.append(f"portal account missing or on another chart: {', '.join(missing)}")
    nested = db.begin_nested()           # the MRN counter answers; the rollback gives it back
    try:
        mrn = db.execute(text("SELECT value FROM admin.next_mrn()")).scalar_one()
        if not mrn.startswith(f"{starter.PRACTICES[0].mrn_prefix}-"):
            problems.append(f"the MRN counter gave {mrn}")
    except Exception as failed:  # noqa: BLE001 (reported as one line, never swallowed)
        problems.append(f"the MRN counter failed: {type(failed).__name__}")
    finally:
        nested.rollback()
    return problems
