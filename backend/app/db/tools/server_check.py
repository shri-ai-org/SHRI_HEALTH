"""The database checks of server day (``~/shri-notes/server-day-runbook.md`` step 3), one line
each, pass or fail, after ``deploy.sh up`` or ``reset``.

    SERVER_CHECK_DATABASE_URL=postgresql+psycopg://postgres:…@host:5432/shri \\
        python -m app.db.tools.server_check --patients 512

It connects as the master user, read-only: the patient count needs a role that row security
doesn't hide rows from, and nothing here writes. The URL comes from the environment and is
never printed. Exit status 0 when every check passes, 1 otherwise. ``--demo`` adds the demo
server's readiness checks (``demo_checks``) after a reset.
"""
# The demo checks build their SQL from the seed's own constants (fixed IDs, codes, counts),
# never from input; the URL is the only value from outside, and it is never part of a query.
# ruff: noqa: S608
from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import Connection, create_engine, text

HEAD = "0021"
#: The demo seed's patients: app.db.seed.demo's PATIENTS and its 500 (a test checks it).
PATIENTS = 512
PGVECTOR = "0.8.2"   # RDS's version (D31); the server image pins it
#: What a failed demo line needs. The seed's rows come back only with a reset: `deploy.sh up`
#: adds missing rows and never changes existing ones (the zone, today's visits).
RESET = "reset needed: deploy.sh reset, after 13:30 IST (up only adds missing rows; Anand's seed)"
AI_FIX = "switch it on in the AI settings as demo.admin, or reset (D118)"
CODES = "load the codes: deploy.sh reset loads them (python -m app.db.terminology all)"


@dataclass(frozen=True)
class Check:
    name: str
    sql: str
    expected: str
    at_least: bool = False   # a count that may be higher (live work adds to it)
    fix: str = ""            # what to do when it fails, printed with the FAIL line

    def passes(self, got: str | None) -> bool:
        if got is None:
            return False
        if self.at_least:
            return got.isdigit() and int(got) >= int(self.expected)
        return got == self.expected


# Clinic tables (those with a tenant_id) without row security both enabled and forced: one with it
# switched off entirely counts too (Thulasi on #270).
UNFORCED = ("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname IN ('clinical', 'admin', 'audit') AND c.relkind IN ('r', 'p') "
            "AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid "
            "AND a.attname = 'tenant_id' AND NOT a.attisdropped) "
            "AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")


def checks(patients: int, head: str = HEAD, pgvector: str = PGVECTOR) -> list[Check]:
    return [
        Check("migrations at head", "SELECT version_num FROM admin.alembic_version", head),
        Check("pgvector is RDS's (D31)",
              "SELECT extversion FROM pg_extension WHERE extname = 'vector'", pgvector),
        Check("row security on and forced on every clinic table", UNFORCED, "0"),
        Check("collation C.UTF-8 (D33)",
              "SELECT datcollate FROM pg_database WHERE datname = current_database()",
              "C.UTF-8"),
        Check("no service role bypasses row security",
              "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'shri\\_%' "
              "AND (rolbypassrls OR rolsuper)",
              "0"),
        Check("demo patients loaded", "SELECT count(*) FROM clinical.patient", str(patients)),
    ]


def demo_checks() -> list[Check]:
    """The demo server's readiness (13 Nov): what the rehearsal and the demo need after a reset,
    in the demo clinic (the master user sees every clinic, so each query names it). "Today" is
    the clinic's own day, in its zone."""
    from app.core.deps import CLINIC_A, FACILITY_A
    from app.db.seed import demo, history, results
    from app.db.seed.starter import PRACTITIONER, sid

    clinic = f"'{CLINIC_A}'::uuid"
    zone = demo.CLINIC_ZONE.key
    shown = ", ".join(f"'{sid(demo.PATIENT, p.n)}'" for p in demo.SHOWN_PATIENTS)
    accounts = [(demo.DEMO_PATIENT_SUBJECT, demo.DEMO_PORTAL_PATIENT),
                *((subject, n) for _, n, _, subject in demo.PORTAL_USERS)]
    pairs = ", ".join(f"('{s}', '{sid(demo.PATIENT, n)}')" for s, n in accounts)

    def short_of(expected: dict[int, int], category_table: str, category: str,
                 extra: str = "") -> str:
        """How many history patients have fewer rows than the seed writes (live work only adds)."""
        values = ", ".join(f"({n}, {c})" for n, c in expected.items())
        parent = "r" if category_table == "diagnostic_report_category" else "o"
        table = "diagnostic_report" if parent == "r" else "observation"
        link = "diagnostic_report_id" if parent == "r" else "observation_id"
        return (f"SELECT count(*) FROM (VALUES {values}) p(n, expected) WHERE (SELECT count(*) "
                f"FROM clinical.{table} {parent} WHERE {parent}.subject_patient_id = "
                "('5eed0017-0000-4000-8000-' || lpad(to_hex(p.n), 12, '0'))::uuid "
                f"{extra}AND EXISTS (SELECT 1 FROM clinical.{category_table} k WHERE "
                f"k.{link} = {parent}.id AND k.category_code = '{category}')) < p.expected")

    def studies(category: str) -> dict[int, int]:
        return {n: sum(1 for s in results.STUDIES if s.patient == n and s.category == category)
                for n in sorted(history.HISTORY)}

    vitals = {n: sum(3 + (r.spo2 is not None) + (r.temperature_f is not None)
                     + (r.respiratory_rate is not None)
                     + (r.day in {v.day for v in h.visits}) for r in history.VITALS[n])
              for n, h in sorted(history.HISTORY.items())}
    return [
        Check("both AI features on in the demo clinic",
              "SELECT count(*) FROM admin.ai_feature_setting WHERE tenant_id = " + clinic +
              " AND is_enabled AND feature IN ('ambient-documentation', 'chart-summary')", "2",
              fix=AI_FIX),
        Check("the demo clinic's time zone", "SELECT timezone FROM admin.tenant WHERE id = " +
              clinic, zone, fix=RESET),
        Check("the demo clinic's main office's time zone",
              f"SELECT timezone FROM admin.facility WHERE id = '{FACILITY_A}'", zone, fix=RESET),
        Check("no demo-clinic facility outside Pacific or Eastern time (the old Central zone)",
              "SELECT count(*) FROM admin.facility WHERE tenant_id = " + clinic +
              " AND timezone NOT IN ('America/Los_Angeles', 'America/New_York')", "0", fix=RESET),
        Check("visits today with demo.doctor (the clinic's day)",
              "SELECT count(DISTINCT a.id) FROM clinical.appointment a JOIN "
              "clinical.appointment_participant x ON x.appointment_id = a.id WHERE "
              f"a.tenant_id = {clinic} AND a.status = 'booked' AND x.actor_practitioner_id = "
              f"'{sid(PRACTITIONER, 3)}' AND (a.start AT TIME ZONE '{zone}')::date = "
              f"(now() AT TIME ZONE '{zone}')::date", "6", at_least=True, fix=RESET),
        Check("the 11 shown patients",
              f"SELECT count(*) FROM clinical.patient WHERE id IN ({shown})",
              str(len(demo.SHOWN_PATIENTS)), fix=RESET),
        Check("portal accounts active on their charts",
              "SELECT count(*) FROM admin.portal_account WHERE status = 'active' AND "
              f"(keycloak_user_id::text, patient_id::text) IN ({pairs})", str(len(accounts)),
              fix=RESET),
        Check("David Nguyen's chart restricted",
              "SELECT 'R' = ANY(meta_security) FROM clinical.patient WHERE id = "
              f"'{sid(demo.PATIENT, 6)}'", "True", fix=RESET),
        Check("the MRN counter is ahead of every MRN",
              "SELECT c.next_value > coalesce(max(substring(i.value FROM '[0-9]+$')::int), 0) "
              "FROM admin.mrn_counter c LEFT JOIN clinical.identifier i ON i.system = c.system "
              f"AND i.type_code = 'MR' WHERE c.tenant_id = {clinic} GROUP BY c.next_value",
              "True", fix="stop registering patients and tell Anand (the MRN counter, D41)"),
        Check("ICD-10-CM codes loaded",
              "SELECT count(*) FROM admin.concept c JOIN admin.code_system s ON s.id = "
              "c.code_system_id WHERE s.uri = 'http://hl7.org/fhir/sid/icd-10-cm'", "90000",
              at_least=True, fix=CODES),
        Check("RxNorm codes loaded",
              "SELECT count(*) FROM admin.concept c JOIN admin.code_system s ON s.id = "
              "c.code_system_id WHERE s.uri = 'http://www.nlm.nih.gov/research/umls/rxnorm'",
              "30000", at_least=True, fix=CODES),
        Check("history patients short of their lab reports",
              short_of(studies("LAB"), "diagnostic_report_category", "LAB",
                       "AND r.status = 'final' "), "0", fix=RESET),
        Check("history patients short of their imaging reports",
              short_of(studies("RAD"), "diagnostic_report_category", "RAD",
                       "AND r.status = 'final' "), "0", fix=RESET),
        Check("history patients short of their vital signs",
              short_of(vitals, "observation_category", "vital-signs"), "0", fix=RESET),
        Check("the alert scenarios (James aspirin; Robert amoxicillin and metformin)",
              "SELECT (SELECT count(*) FROM clinical.allergy_intolerance WHERE patient_id = "
              f"'{sid(demo.PATIENT, 4)}' AND code_code = '1191' AND clinical_status = 'active') "
              "+ (SELECT count(*) FROM clinical.allergy_intolerance WHERE patient_id = "
              f"'{sid(demo.PATIENT, 2)}' AND code_code = '723' AND clinical_status = 'active') "
              "+ (SELECT count(*) FROM clinical.medication_request WHERE subject_patient_id = "
              f"'{sid(demo.PATIENT, 2)}' AND medication_codeable_concept_code = '861007' "
              "AND status = 'active')", "3", fix=RESET),
    ]


def run(conn: Connection, todo: Sequence[Check]) -> list[tuple[Check, str | None]]:
    """Each check with the value the database gave (None: the query itself failed)."""
    results: list[tuple[Check, str | None]] = []
    for check in todo:
        try:
            with conn.begin_nested():
                got = conn.execute(text(check.sql)).scalar()
            results.append((check, None if got is None else str(got)))
        except Exception:   # noqa: BLE001 - a missing table or extension is a failed check
            results.append((check, None))
    return results


def line(check: Check, got: str | None) -> str:
    """The check's output line: PASS, or FAIL with what was expected and what to do."""
    if check.passes(got):
        return f"PASS  {check.name}: {got}"
    want = f"at least {check.expected}" if check.at_least else check.expected
    return (f"FAIL  {check.name}: {got if got is not None else 'error'} (expected {want})"
            + (f"; {check.fix}" if check.fix else ""))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.db.tools.server_check",
                                     description=__doc__.splitlines()[0])
    parser.add_argument("--patients", type=int, default=PATIENTS,
                        help=f"patients the demo seed loads (default {PATIENTS})")
    parser.add_argument("--head", default=HEAD, help=f"Alembic head (default {HEAD})")
    parser.add_argument("--pgvector", default=PGVECTOR,
                        help=f"pgvector version (default {PGVECTOR})")
    parser.add_argument("--demo", action="store_true",
                        help="also the demo server's readiness: AI, today's visits, the shown "
                             "patients, portal accounts, results and reports, the alert data")
    args = parser.parse_args(argv)
    url = os.environ.get("SERVER_CHECK_DATABASE_URL")
    if not url:
        print("server_check: set SERVER_CHECK_DATABASE_URL (the master user)", file=sys.stderr)
        return 2
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SET TRANSACTION READ ONLY"))
            todo = checks(args.patients, args.head, args.pgvector)
            results = run(conn, todo + (demo_checks() if args.demo else []))
    finally:
        engine.dispose()
    failed = sum(not check.passes(got) for check, got in results)
    for check, got in results:
        print(line(check, got))
    print(f"{len(results) - failed} of {len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
