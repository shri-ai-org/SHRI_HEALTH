"""A performance baseline on a throwaway database (D35's first part; see perf_baseline.md).

It creates its own database, named ``shri_perf_<UTC time>_<6 hex>``, migrates it to head,
loads the starter and demo layers, adds a third clinic and tops each clinic up to 2,000
synthetic patients (two past visits with three vital signs each), then times, over 200 runs:

  patient search   POST /patients/search, half a name prefix, half an MRN (D117's query)
  chart read       GET the patient, their vital signs and their encounters, one after another
  free times       GET /slots at the demo clinic's main office
  create visit     fhir_store.create_encounter as shri_app, one transaction per run
  file result      fhir_store.record_report (a lipid panel, three results) after an untimed
                   record_order, one transaction per run

It prints the median and p95 of each, EXPLAIN (ANALYZE, BUFFERS) of the five slowest read
statements, and drops its database at the end, after a failure too.

Safety: it runs only where ENVIRONMENT is development or test, never on a demo server
(SHRI_DEMO=true). It touches no database but the one it created, by name, and refuses any name
outside its own pattern (so never shri_health, postgres, keycloak or a template). The master
login comes from PERF_ADMIN_DATABASE_URL (postgresql+psycopg://...) and is never printed.
It isn't part of the test suite or CI: run it by hand. Fictional data only: generated names with
digits, 555-01xx phone numbers.

Usage: python -m app.db.tools.perf_baseline [--patients 2000] [--runs 200] [--keep]
"""
# ruff: noqa: S608
# S608: the only SQL built from strings names one of two fixed roles or this tool's own
# database, checked against its pattern first.
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import os
import random
import re
import secrets
import statistics
import subprocess
import sys
import time
import uuid
from collections import defaultdict
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

ADMIN_URL_SETTING = "PERF_ADMIN_DATABASE_URL"
NAME = re.compile(r"^shri_perf_[0-9]{14}_[0-9a-f]{6}$")
NEVER = frozenset({"shri_health", "postgres", "keycloak", "template0", "template1"})
ALLOWED_ENVIRONMENTS = frozenset({"development", "test"})
CLINIC_C = uuid.UUID("5eed0f00-0000-4000-8000-00000000000c")
MRN_OID = "urn:oid:2.16.840.1.113883.3.0000.9"  # + the clinic's number
#: The baseline recorded on 13 Nov 2026 (perf_baseline.md), shown next to each new run.
EARLIER = {"patient search": (26.5, 66.0), "chart read": (49.6, 58.4),
           "free times": (12.7, 15.9)}
OPERATIONS = ("patient search", "chart read", "free times", "create visit", "file result")
GIVEN = ("Avery", "Jordan", "Riley", "Morgan", "Casey", "Quinn", "Rowan", "Sage", "Emery",
         "Harper", "Reese", "Dakota", "Skyler", "Finley", "Hayden", "Kendall")
FAMILY = ("Abernathy", "Brightwater", "Castellan", "Dunmore", "Elsworth", "Fairbanks",
          "Greystone", "Halloway", "Ironwood", "Juniper", "Kingsley", "Lockridge")
VITALS = (("8867-4", "Heart rate", "/min", 55, 95), ("29463-7", "Body weight", "kg", 50, 120),
          ("8302-2", "Body height", "cm", 150, 195))
LIPIDS = (("2093-3", "Cholesterol [Mass/volume] in Serum or Plasma", 120, 260),
          ("2085-9", "HDL Cholesterol", 30, 90),
          ("2571-8", "Triglyceride [Mass/volume] in Serum or Plasma", 50, 300))
NOT_READS = ("SET", "SELECT SET_CONFIG", "BEGIN", "COMMIT", "ROLLBACK", "INSERT", "UPDATE",
             "DELETE", "SAVEPOINT", "RELEASE")


# ========================================================================== guards
class Refused(RuntimeError):
    """The tool won't run here, or won't touch this database."""


def check_environment(env: Mapping[str, str]) -> None:
    """Only on a development or test machine: never a demo server, never production."""
    environment = env.get("ENVIRONMENT", "").strip().lower()
    if environment not in ALLOWED_ENVIRONMENTS:
        raise Refused(f"ENVIRONMENT must be development or test, not {environment or 'unset'!r}")
    if env.get("SHRI_DEMO", "").strip().lower() == "true":
        raise Refused("never on a demo server (SHRI_DEMO=true)")


def check_database_name(name: str) -> None:
    """Only a database this tool named: its own pattern, and never one of the real ones."""
    if name in NEVER or not NAME.fullmatch(name):
        raise Refused(f"not a perf_baseline database: {name!r}")


def new_database_name(now: dt.datetime, token: str) -> str:
    name = f"shri_perf_{now.astimezone(dt.UTC):%Y%m%d%H%M%S}_{token}"
    check_database_name(name)
    return name


# ===================================================================== population
@dataclass(frozen=True)
class Person:
    given: str
    family: str
    gender: str
    birth_date: dt.date
    mrn: str
    phone: str
    visits: tuple[dt.datetime, ...]
    vitals: tuple[int, ...]  # one value per VITALS entry, the same at both visits


def person(clinic_no: int, n: int) -> Person:
    """Patient n of clinic clinic_no, the same on every run: its own seed, (clinic, n)."""
    rng = random.Random(f"perf-{clinic_no}-{n}")  # noqa: S311 (the same people every run)
    gender = rng.choice(("female", "male"))
    given = f"{rng.choice(GIVEN)}{rng.randrange(100, 1000)}"
    family = f"{rng.choice(FAMILY)}{rng.randrange(10, 1000)}"
    birth = dt.date(1940, 1, 1) + dt.timedelta(days=rng.randrange(80 * 365))
    phone = f"+1408555{rng.randrange(100, 200):04d}"
    visits = tuple(dt.datetime(2026, 11, 1, 17, tzinfo=dt.UTC)
                   - dt.timedelta(days=rng.randrange(14, 700), minutes=20 * rng.randrange(24))
                   for _ in range(2))
    vitals = tuple(rng.randrange(lo, hi) for *_, lo, hi in VITALS)
    return Person(given, family, gender, birth, f"PERF{clinic_no}-{n:06d}", phone, visits,
                  vitals)


def population(clinic_no: int, first: int, last: int) -> Iterator[Person]:
    return (person(clinic_no, n) for n in range(first, last + 1))


# ========================================================================= database
def _admin_url(env: Mapping[str, str]) -> URL:
    raw = env.get(ADMIN_URL_SETTING)
    if not raw:
        raise Refused(f"set {ADMIN_URL_SETTING} (the master login, postgresql+psycopg://...)")
    return make_url(raw).set(drivername="postgresql+psycopg")


def _autocommit(url: URL) -> Engine:
    return create_engine(url, isolation_level="AUTOCOMMIT", poolclass=NullPool)


def _create(admin: URL, name: str) -> None:
    check_database_name(name)
    engine = _autocommit(admin.set(database="postgres"))
    with engine.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}" OWNER shri_migrator TEMPLATE template0 '
                       "ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C.UTF-8'"))
    engine.dispose()
    engine = _autocommit(admin.set(database=name))
    with engine.connect() as c:
        c.execute(text("ALTER SCHEMA public OWNER TO shri_migrator"))
        # The script's own format('%I') calls: run it without parameters, as psql would.
        cursor = c.connection.dbapi_connection.cursor()  # type: ignore[union-attr]
        cursor.execute((Path(__file__).parents[1] / "sql" / "00_extensions.sql").read_text())
        cursor.close()
        # Alembic sets its own connection options, so a URL's role is lost: every login of the
        # master user to this database becomes shri_migrator instead (set as the script ends,
        # and gone with the database).
        c.execute(text(f'ALTER ROLE CURRENT_USER IN DATABASE "{name}" SET role = shri_migrator'))
    engine.dispose()


def _drop(admin: URL, name: str) -> None:
    check_database_name(name)
    engine = _autocommit(admin.set(database="postgres"))
    with engine.connect() as c:
        c.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                       "WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": name})
        c.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
    engine.dispose()


def _role_search_path(role: str) -> str:
    """The role's own configured search_path (sql/00_extensions.sql), which SET ROLE skips."""
    return (
        "SELECT set_config('search_path', substr(cfg, length('search_path=') + 1), false) "
        "FROM pg_db_role_setting s, unnest(s.setconfig) AS cfg "
        f"WHERE s.setrole = '{role}'::regrole AND s.setdatabase = 0 "
        "AND starts_with(cfg, 'search_path=')")


def as_role(engine: Engine, role: str) -> None:
    """Every new connection of ``engine`` runs as ``role``, with that role's search_path."""
    if role not in ("shri_app", "shri_migrator"):
        raise ValueError(role)

    @event.listens_for(engine, "connect")
    def _switch(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute(_role_search_path(role))
            cursor.execute(f"SET ROLE {role}")
        finally:
            cursor.close()
        dbapi_connection.commit()


def _migrate(admin: URL, name: str) -> None:
    migrator = admin.set(database=name)  # shri_migrator by the database's role setting
    subprocess.run(  # noqa: S603 - fixed arguments, the repository's own Alembic config
        [sys.executable, "-m", "alembic", "-c", "app/db/alembic.ini", "upgrade", "head"],
        check=True, cwd=Path(__file__).parents[3], capture_output=True,
        env={**os.environ, "MIGRATION_DATABASE_URL": migrator.render_as_string(False)})


def _seed(url: URL) -> None:
    from app.db.seed import starter
    from app.db.seed.demo import load_demo

    engine = create_engine(url, poolclass=NullPool)
    as_role(engine, "shri_migrator")
    with Session(engine) as db, db.begin():
        starter.load_starter(db)
        load_demo(db)
        starter._practice(db, starter.Practice(
            CLINIC_C, "perf-c", "Perf clinic C (synthetic)", "America/Los_Angeles", "PFC",
            "https://company-domain.invalid/sid/mrn/PFC",
            ((None, "MAIN", "Perf clinic C office (synthetic)", "America/Los_Angeles",
              ("100 Sample Avenue", "San Jose", "CA", "95126")),)), 3)
    engine.dispose()


def _populate(engine: Engine, tenant: uuid.UUID, clinic_no: int, target: int) -> int:
    """Tops the clinic up to ``target`` patients (those already there count) as shri_app."""
    from app.db.models import MAPPERS as M  # noqa: N811
    from app.db.models import systems

    with Session(bind=engine.connect()) as db:
        db.info["tenant_id"] = tenant
        db.execute(text("SELECT set_config('app.current_tenant_id', :t, false)"),
                   {"t": str(tenant)})
        have = db.execute(text("SELECT count(*) FROM clinical.patient")).scalar_one()
        org = db.execute(text("SELECT id FROM clinical.organization LIMIT 1")).scalar_one()
        for i, p in enumerate(population(clinic_no, have + 1, target), start=1):
            pt = M["patient"](gender=p.gender, birth_date=p.birth_date,
                              ext_birthsex=p.gender[0].upper())
            pt.name = [M["human_name"](use="official", family=p.family, given=[p.given])]
            pt.identifier = [M["identifier"](system=f"{MRN_OID}{clinic_no}", value=p.mrn,
                                             type_system=systems.V2_0203, type_code="MR",
                                             use="usual")]
            pt.telecom = [M["contact_point"](system="phone", use="mobile", rank=1,
                                              value=p.phone)]
            db.add(pt)
            db.flush()
            for start in p.visits:
                e = M["encounter"](status="finished", class_="AMB", subject_patient_id=pt.id,
                                   period_start=start, period_end=start + dt.timedelta(minutes=20),
                                   service_provider_organization_id=org)
                db.add(e)
                db.flush()
                for (code, display, unit, *_), value in zip(VITALS, p.vitals, strict=True):
                    o = M["observation"](status="final", code_system=systems.LOINC,
                                         code_code=code, code_display=display,
                                         subject_patient_id=pt.id, encounter_id=e.id,
                                         effective_date_time=start, issued=start,
                                         value_quantity_value=Decimal(value),
                                         value_quantity_unit=unit, value_quantity_code=unit,
                                         value_quantity_system=systems.UCUM)
                    o.category = [M["observation_category"](
                        category_system=systems.OBSERVATION_CATEGORY,
                        category_code="vital-signs")]
                    db.add(o)
            if i % 200 == 0:
                db.commit()
        db.commit()
        return max(target - int(have), 0)


# ========================================================================== timing
def pct(xs: list[float], p: float) -> float:
    ordered = sorted(xs)
    return ordered[min(len(ordered) - 1, int(round(p * (len(ordered) - 1))))]


class Timings:
    def __init__(self) -> None:
        self.ops: dict[str, list[float]] = defaultdict(list)
        self.sql: dict[str, list[float]] = defaultdict(list)
        self.params: dict[str, Any] = {}

    def watch(self, engine: Engine) -> None:
        @event.listens_for(engine, "before_cursor_execute")
        def _start(conn: Any, cursor: Any, statement: str, *_: Any) -> None:
            conn.info.setdefault("t0", []).append(time.perf_counter())

        @event.listens_for(engine, "after_cursor_execute")
        def _end(conn: Any, cursor: Any, statement: str, params: Any, *_: Any) -> None:
            ms = (time.perf_counter() - conn.info["t0"].pop()) * 1000
            if ms >= max(self.sql[statement], default=0.0):
                self.params[statement] = params
            self.sql[statement].append(ms)


def _sample(url: URL) -> list[tuple[uuid.UUID, str, str, str]]:
    """Clinic A's generated patients: (id, family, given, MRN)."""
    from app.core.deps import CLINIC_A

    engine = create_engine(url, poolclass=NullPool)
    as_role(engine, "shri_app")
    with engine.connect() as c:
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, false)"),
                  {"t": str(CLINIC_A)})
        rows = c.execute(text(
            "SELECT i.patient_id, n.family, n.given[1], i.value FROM clinical.identifier i "
            "JOIN clinical.human_name n ON n.patient_id = i.patient_id "
            "WHERE i.system = :s ORDER BY i.value"), {"s": f"{MRN_OID}1"})
        sample = [(r[0], r[1], r[2], r[3]) for r in rows]
    engine.dispose()
    return sample


def _time_api(url: URL, runs: int, t: Timings) -> None:
    from fastapi.testclient import TestClient
    from pydantic import SecretStr

    from app.core.config import Settings
    from app.core.deps import DEV_USER_HEADER, FACILITY_A
    from app.main import create_app

    sample, rng = _sample(url), random.Random(20261113)  # noqa: S311 (a repeatable sample)
    app = create_app(Settings(
        environment="test", auth_mode="dev_header",
        database_url=SecretStr(url.set(drivername="postgresql+asyncpg").render_as_string(False))))
    engine = app.state.db.engine.sync_engine
    as_role(engine, "shri_app")
    t.watch(engine)
    with TestClient(app, raise_server_exceptions=False) as client:
        def timed(name: str | None, user: str, method: str, path: str, **kw: Any) -> None:
            client.headers[DEV_USER_HEADER] = user
            t0 = time.perf_counter()
            r = client.request(method, f"/api/v1{path}", **kw)
            if name:
                t.ops[name].append((time.perf_counter() - t0) * 1000)
            if r.status_code >= 400:
                raise RuntimeError(f"{method} {path.split('/')[1]}: {r.status_code}")

        for _ in range(5):                                       # warm-up, not counted
            timed(None, "md", "GET", f"/patients/{sample[0][0]}")
        t.sql.clear()
        for i in range(runs):
            _, family, given, mrn = rng.choice(sample)
            query = f"{family[:6]} {given[:3]}" if i % 2 else mrn
            timed("patient search", "fd", "POST", "/patients/search",
                  json={"criteria": {"query": query}})
        for _ in range(runs):
            pid = rng.choice(sample)[0]
            t0 = time.perf_counter()
            for path in (f"/patients/{pid}", f"/patients/{pid}/vitals",
                         f"/patients/{pid}/encounters"):
                timed(None, "md", "GET", path)
            t.ops["chart read"].append((time.perf_counter() - t0) * 1000)
        for _ in range(runs):
            day = dt.date(2026, 11, 16) + dt.timedelta(days=rng.randrange(5))
            timed("free times", "fd", "GET", "/slots",
                  params={"date": day.isoformat(), "facilityId": str(FACILITY_A)})
        if client.portal is not None:  # the app's engine closes in the client's event loop
            client.portal.call(app.state.db.dispose)


async def _time_writes(url: URL, runs: int, t: Timings) -> None:
    from app.core.db import TENANT_ID_INFO_KEY
    from app.core.deps import CLINIC_A, DEV_USERS, FACILITY_A
    from app.db import fhir_store as fs
    from app.db.models import systems
    from app.db.seed.starter import ORG, PRACTITIONER, sid

    engine = create_async_engine(url.set(drivername="postgresql+asyncpg"), poolclass=NullPool)
    as_role(engine.sync_engine, "shri_app")
    store, rng = fs.SqlFhirStore(), random.Random(20261114)  # noqa: S311 (repeatable)
    patients = [row[0] for row in _sample(url)]
    doctor, org = sid(PRACTITIONER, 1), sid(ORG, 1)
    panel = fs.Coded(systems.LOINC, "57698-3", "Lipid panel with direct LDL - Serum or Plasma")

    async def visit(db: AsyncSession, pid: uuid.UUID) -> uuid.UUID:
        written = await store.create_encounter(db, fs.EncounterIn(
            patient_id=pid, facility_id=FACILITY_A, status="in-progress",
            service_provider_organization_id=org,
            participants=(fs.ParticipantIn(practitioner_id=doctor),)))
        return written.id

    async def run(name: str) -> None:
        async with AsyncSession(engine, expire_on_commit=False) as db:
            db.info[TENANT_ID_INFO_KEY] = CLINIC_A
            await db.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                                  "set_config('app.current_user_id', :u, true)"),
                             {"t": str(CLINIC_A), "u": str(DEV_USERS["md"].id)})
            pid = rng.choice(patients)
            if name == "create visit":
                t0 = time.perf_counter()
                await visit(db, pid)
                await db.commit()
            else:
                encounter = await visit(db, pid)
                now = dt.datetime.now(dt.UTC)
                order = await store.record_order(db, fs.OrderIn(
                    patient_id=pid, encounter_id=encounter, code=panel, category="laboratory",
                    requester_practitioner_id=doctor, signed_at=now - dt.timedelta(hours=3)))
                t0 = time.perf_counter()
                await store.record_report(db, fs.ReportIn(
                    patient_id=pid, encounter_id=encounter, order_id=order.id, category="LAB",
                    code=panel, effective=now - dt.timedelta(hours=2),
                    issued=now - dt.timedelta(minutes=5), performer_organization_id=org,
                    results=tuple(
                        fs.ResultIn(fs.Coded(systems.LOINC, code, display),
                                    fs.Measured(Decimal(rng.randrange(lo, hi)), "mg/dL"))
                        for code, display, lo, hi in LIPIDS)))
                await db.commit()
            t.ops[name].append((time.perf_counter() - t0) * 1000)

    for name in ("create visit", "file result"):
        for _ in range(runs):
            await run(name)
    await engine.dispose()


def _explain(url: URL, t: Timings) -> None:
    import psycopg
    from psycopg import sql

    from app.core.deps import CLINIC_A, DEV_USERS

    ranked = sorted(((pct(xs, .95), s) for s, xs in t.sql.items()
                     if not s.lstrip().upper().startswith(NOT_READS)), reverse=True)[:5]
    print("\nEXPLAIN (ANALYZE, BUFFERS) of the five slowest reads, as shri_app in clinic A:")
    with psycopg.connect(url.set(drivername="postgresql").render_as_string(False),
                         autocommit=True) as c:
        c.execute(_role_search_path("shri_app"))
        c.execute("SET ROLE shri_app")
        c.execute("SELECT set_config('app.current_tenant_id', %s, false), "
                  "set_config('app.current_user_id', %s, false)",
                  (str(CLINIC_A), str(DEV_USERS["fd"].id)))
        for i, (p95, statement) in enumerate(ranked):
            # asyncpg's $n placeholders are PostgreSQL's own, so PREPARE takes the text as is.
            c.execute(sql.SQL("PREPARE {} AS {}").format(
                sql.Identifier(f"q{i}"), sql.SQL(statement)))
            params = t.params.get(statement) or ()
            args = (sql.SQL("({})").format(sql.SQL(", ").join(sql.Literal(p) for p in params))
                    if params else sql.SQL(""))
            plan = c.execute(sql.SQL("EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) EXECUTE {}{}")
                             .format(sql.Identifier(f"q{i}"), args)).fetchall()
            print(f"\n--- #{i + 1}, p95 {p95:.2f} ms: {' '.join(statement.split())[:200]}")
            print("\n".join(row[0] for row in plan))


def report(ops: Mapping[str, list[float]], runs: int) -> str:
    lines = [f"{'operation':16} {'median ms':>10} {'p95 ms':>8}   13 Nov median / p95"]
    for name in OPERATIONS:
        xs = ops[name]
        before = EARLIER.get(name)
        was = f"{before[0]:.1f} / {before[1]:.1f}" if before else "-"
        lines.append(f"{name:16} {statistics.median(xs):10.1f} {pct(xs, .95):8.1f}   {was}")
    lines.append(f"({runs} runs each)")
    return "\n".join(lines)


# ============================================================================= main
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.db.tools.perf_baseline")
    parser.add_argument("--patients", type=int, default=2000, help="per clinic (3 clinics)")
    parser.add_argument("--runs", type=int, default=200)
    parser.add_argument("--keep", action="store_true", help="keep the database afterwards")
    args = parser.parse_args(argv)
    try:
        check_environment(os.environ)
        admin = _admin_url(os.environ)
    except Refused as refused:
        print(f"perf_baseline: {refused}", file=sys.stderr)
        return 2
    from app.core.deps import CLINIC_A, CLINIC_B

    name = new_database_name(dt.datetime.now(dt.UTC), secrets.token_hex(3))
    url = admin.set(database=name)
    print(f"{name}: creating, migrating, seeding", flush=True)
    try:
        _create(admin, name)
        _migrate(admin, name)
        _seed(url)
        app_engine = create_engine(url, poolclass=NullPool)
        as_role(app_engine, "shri_app")
        for n, tenant in enumerate((CLINIC_A, CLINIC_B, CLINIC_C), start=1):
            added = _populate(app_engine, tenant, n, args.patients)
            print(f"clinic {n}: {added} patients added, {args.patients} in all", flush=True)
        app_engine.dispose()
        t = Timings()
        _time_api(url, args.runs, t)
        asyncio.run(_time_writes(url, args.runs, t))
        print("\n" + report(t.ops, args.runs))
        _explain(url, t)
    finally:
        if args.keep:
            print(f"kept {name}")
        else:
            _drop(admin, name)
            print(f"dropped {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
