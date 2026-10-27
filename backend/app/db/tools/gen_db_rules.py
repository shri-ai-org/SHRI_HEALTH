"""Generate the model-derived SQL that migration 0002 freezes:

  sql/01_schema.sql           tables, keys, constraints and indexes (DDL compiled from models)
  sql/20_fhir_versioning.sql  snapshot functions + version / history / touch triggers
  sql/30_guards.sql           attaches the hand-written rule functions (sql/10_rules.sql)
  sql/90_rls_grants.sql       row-level security policies and privileges, for all 5 roles,
                              across the clinical/admin/audit schemas (D23)
  sql/92_fhir_visibility.sql  what /fhir may see: restricted charts hidden from shri_fhir_reader,
                              and the audit function for a lookup it cannot serve (D22, 0006)
  sql/95_seed.sql             code systems and the settings catalogue (roles and permissions
                              live in core)

Usage:  python -m app.db.tools.gen_db_rules     (writes the files above)

Migrations must stay frozen: after changing models, generate SQL for the new tables only and
paste it into the new revision (see README "Adding a table").

Role bootstrap note: the five service roles (shri_app, shri_fhir_reader, shri_integration,
shri_reporting, shri_migrator) are NOT created here. Locally/CI they're created by
infra/compose/postgres/initdb/10-service-roles.sh (Thulasi); on RDS, by the master role plus
shri_migrator (ADR-0012). This module only ever GRANTs to roles it assumes already exist.
"""
from __future__ import annotations

import pathlib
import sys
from typing import Any

from sqlalchemy import Table

from app.db.base import ADMIN_SCHEMA, AUDIT_SCHEMA, CLINICAL_SCHEMA, Base
from app.db.constraints import patient_column, referenced_table
from app.db.models import FHIR_RESOURCES, GLOBAL_TABLES, MAPPERS, systems
from app.db.models.admin.core import SETTINGS

ROOT = pathlib.Path(__file__).resolve().parents[1]   # backend/app/db
TENANT = "NULLIF(current_setting('app.current_tenant_id', true), '')::uuid"

# Admin tables shri_app may DELETE from (configuration and draft lines). FHIR child tables are
# deletable too (guarded by their parent's state). Resource roots, financial, audit and
# integration rows are never deleted: they are corrected with a status.
DELETABLE_ADMIN = {
    "availability_rule_appointment_type", "care_team_member", "charge_diagnosis_pointer",
    "charge_modifier", "compendium_aoe_option", "compendium_aoe_question",
    "compendium_covered_diagnosis", "compendium_panel_member", "compendium_test_code",
    "eligibility_service_type", "employer", "fee_schedule_item", "integration_endpoint_setting",
    "knowledge_chunk", "knowledge_source_role", "lab_account_bill_to", "note_template_section",
    "order_set_item", "patient_pharmacy", "picklist_item", "prescription_favorite",
    "role_permission", "schedule_availability_rule", "schedule_exception",
    "service_request_aoe_answer", "smart_phrase", "tenant_setting", "user_alert_suppression",
    "user_favorite", "user_role",
}
# Nullable tenant_id, but tenants only ever see their own rows.
TENANT_ONLY = {"audit_event"}
# Insert-only tables (no UPDATE / DELETE, enforced by trigger and by privileges).
INSERT_ONLY = {
    "audit_event", "fhir_resource_history", "work_item_event", "result_acknowledgement",
    "claim_status_event", "service_request_status_event", "visit_flow_event",
    "patient_merge_record", "ai_suggestion_evidence", "ai_suggestion_unknown",
    "detected_issue_mitigation", "composition_attester", "provenance", "provenance_agent",
    "provenance_entity", "provenance_signature", "eligibility_benefit",
}
# Written only by SECURITY DEFINER functions.
NO_APP_WRITE = {"fhir_resource_history"}
# Short-lived runtime tables of Thulasi's core (issue #13, migration 0005). No role deletes from
# them: only admin.purge_expired_runtime_rows() does, past retention (Thulasi's review of #52).
RUNTIME = {"app_session", "event_log", "idempotency_record", "operation"}
# Written once and never changed: no UPDATE.
WRITE_ONCE = {"event_log"}

#: shri_app on the two audit tables: D23/ADR-0011 condition 4 says "audit insert only" for
#: shri_app overall. audit_event: insert only, no read-back (matches INSERT_ONLY's no-UPDATE
#: already; SELECT is withheld here specifically). break_glass_access: the app needs to check
#: existing break-glass status before granting a new one, so SELECT+INSERT - this one table is
#: my proposal, not an explicit decision; flagged in the adoption report for review.
AUDIT_APP_PRIVS = {"audit_event": ["INSERT"], "break_glass_access": ["SELECT", "INSERT"]}

#: shri_integration (D23: "integration tables plus result filing"). Table list is this
#: adoption's proposal (not an explicit decision beyond the prose) - flagged in the report.
INTEGRATION_ADMIN_TABLES = {"integration_endpoint", "integration_endpoint_setting",
                            "integration_message"}
#: Read access so the partner worker can match an incoming result against the order it answers.
INTEGRATION_READ_TABLES = {
    "service_request", "service_request_category", "service_request_coding",
    "service_request_performer", "service_request_reason", "service_request_insurance",
    "service_request_specimen", "service_request_aoe_answer",
}
#: Write access for filing the result itself.
INTEGRATION_WRITE_TABLES = {
    "diagnostic_report", "diagnostic_report_category", "diagnostic_report_coding",
    "diagnostic_report_based_on", "diagnostic_report_performer", "diagnostic_report_specimen",
    "diagnostic_report_result", "diagnostic_report_presented_form",
    "observation", "observation_category", "observation_coding", "observation_performer",
    "observation_interpretation", "observation_reference_range", "observation_has_member",
    "observation_component", "service_request_status_event", "unmatched_result",
    "unmatched_result_candidate",
}

EDITABLE_RESULT = "registered,partial,preliminary,amended,corrected,appended,cancelled,unknown"
GUARDS = {
    # table: [(trigger name suffix, timing/events, function call)]
    "composition": [
        ("guard", "BEFORE UPDATE", "shri_composition_guard()"),
    ],
    "composition_attester": [("guard", "BEFORE INSERT", "shri_composition_attester_guard()")],
    "medication_request": [("guard", "BEFORE UPDATE", "shri_medication_request_guard()")],
    "service_request": [("guard", "BEFORE UPDATE", "shri_service_request_guard()")],
    "observation": [("guard", "BEFORE UPDATE", "shri_final_result_guard()")],
    "diagnostic_report": [("guard", "BEFORE UPDATE", "shri_final_result_guard("
                           "'ext_released_to_patient_at', 'ext_released_by_user_id')")],
    "ai_suggestion": [("guard", "BEFORE UPDATE", "shri_ai_suggestion_guard()")],
    "audio_recording": [("consent", "BEFORE INSERT", "shri_audio_consent_check()")],
    "appointment_participant": [("sync", "BEFORE INSERT OR UPDATE", "shri_participant_sync()")],
    "appointment": [("sync", 'AFTER UPDATE OF start, "end", status, ext_overbook, '
                             "ext_appointment_type_id", "shri_appointment_sync()")],
    "provenance": [("target", "BEFORE INSERT", "shri_provenance_target_check()")],
    "audit_event": [("chain", "BEFORE INSERT", "shri_audit_chain()")],
    # Migration 0007 (A45): a self-pay visit never produces an insurance claim, except the
    # void of one sent before the visit became self-pay; an MRN is never reused (D41); an
    # employer change is a change to its patient or related person.
    "claim": [("self_pay", "BEFORE INSERT OR UPDATE OF superbill_id, frequency_code",
               "shri_claim_not_self_pay()")],
    "mrn_counter": [("guard", "BEFORE UPDATE", "shri_mrn_counter_guard()")],
    # A real IANA zone name (D40): a wrong one breaks every time shown at the practice.
    "facility": [("timezone", "BEFORE INSERT OR UPDATE OF timezone", "shri_timezone_check()")],
    "tenant": [("timezone", "BEFORE INSERT OR UPDATE OF timezone", "shri_timezone_check()")],
    "employer": [("touch", "AFTER INSERT OR UPDATE OR DELETE",
                  "shri_fhir_touch_parent('patient_id', 'patient', 'meta_last_updated', "
                  "'related_person_id', 'related_person', 'meta_last_updated')")],
    # Migration 0008 (A43): a consent requirement keeps its kind (D59); a merge records the
    # versions it starts from, and is undone only while nothing it touched has changed (D51).
    "consent_requirement": [("kind", "BEFORE UPDATE OF kind", "shri_fixed_columns('kind')")],
    "patient_merge": [("versions", "BEFORE INSERT", "shri_patient_merge_versions()"),
                      ("guard", "BEFORE UPDATE", "shri_patient_merge_guard()")],
    "patient_merge_record": [("version", "BEFORE INSERT", "shri_patient_merge_record_version()")],
    "break_glass_access": [("guard", "BEFORE UPDATE",
                            "shri_freeze_except('reviewed_by_user_id', 'reviewed_at')")],
    "composition_section": [("content", "BEFORE INSERT OR UPDATE OR DELETE",
                             "shri_composition_content_guard()")],
    "composition_section_entry": [("content", "BEFORE INSERT OR UPDATE OR DELETE",
                                   "shri_composition_content_guard()")],
    "composition_author": [("content", "BEFORE INSERT OR UPDATE OR DELETE",
                            "shri_composition_content_guard()")],
    "composition_relates_to": [("content", "BEFORE INSERT OR UPDATE OR DELETE",
                                "shri_composition_content_guard()")],
}
DEFERRED = {
    "composition": ("signed", "shri_composition_signed_check()"),
    "medication_request": ("alerts", "shri_medication_request_alert_check()"),
    # An undo that would leave a record pointing at another patient's (0008, D51).
    "patient_merge": ("undo", "shri_patient_merge_undo_check()"),
}
#: Admin tables with VersionedMixin (A41/issue #13): practice-setup resources and
#: patient_pharmacy, none of which have a FHIR meta_version_id of their own; tenant_setting for
#: PATCH /practice-settings (A49, migration 0007); consent_requirement (D59, migration 0008).
VERSIONED_TABLES = {"facility", "appointment_type", "note_template", "lab_provider",
                    "lab_account", "patient_pharmacy", "payer", "fee_schedule",
                    "practice_payer", "tenant_setting", "consent_requirement"}
# child table -> (fk column, parent table, editable parent statuses)
FROZEN_CHILDREN = {
    "dosage": ("medication_request_id", "medication_request", "draft"),
    "medication_request_reason": ("medication_request_id", "medication_request", "draft"),
    **{t: ("service_request_id", "service_request", "draft") for t in (
        "service_request_category", "service_request_coding", "service_request_performer",
        "service_request_reason", "service_request_insurance", "service_request_specimen",
        "service_request_aoe_answer")},
    **{t: ("observation_id", "observation", EDITABLE_RESULT) for t in (
        "observation_category", "observation_coding", "observation_performer",
        "observation_interpretation", "observation_reference_range", "observation_has_member",
        "observation_component")},
    **{t: ("diagnostic_report_id", "diagnostic_report", EDITABLE_RESULT) for t in (
        "diagnostic_report_category", "diagnostic_report_coding", "diagnostic_report_based_on",
        "diagnostic_report_performer", "diagnostic_report_specimen", "diagnostic_report_result",
        "diagnostic_report_presented_form")},
    "charge": ("superbill_id", "superbill", "draft,ready-for-review"),
}


def _q(schema: str, table: str) -> str:
    """Schema-qualified, quoted-safe table reference for generated SQL."""
    return f"{schema}.{table}"


def _schema_of(table: Table) -> str:
    if table.schema is None:   # never: base.py gives every table a schema (D23)
        raise ValueError(f"table {table.name} has no schema")
    return table.schema


def child_map() -> dict[str, list[tuple[str, str]]]:
    """parent table (bare name) -> [(child table, fk column)] for FHIR child/datatype tables."""
    out: dict[str, list[tuple[str, str]]] = {}
    for name, cls in sorted(MAPPERS.items()):
        for col in getattr(cls, "fhir_parent", ()):
            parent = referenced_table(cls.__table__.c[col])
            out.setdefault(parent.name, []).append((name, col))
    return out


def _children_expr(table: str, alias: str, depth: int,
                   cmap: dict[str, list[tuple[str, str]]]) -> str:
    kids = cmap.get(table, [])
    if not kids:
        return f"to_jsonb({alias})"
    names = [c for c, _ in kids]
    pairs = []
    for child, fk in kids:
        key = child if names.count(child) == 1 else f"{child}.{fk}"
        a = f"c{depth}"
        inner = _children_expr(child, a, depth + 1, cmap)
        # child is always clinical (FHIR child tables are never in admin/audit).
        # S608: SQL built from model names only; this generator never sees user input.
        pairs.append(f"'{key}', coalesce((SELECT "  # noqa: S608
                     f"jsonb_agg({inner} ORDER BY {a}.created_at, {a}.id) "
                     f"FROM {_q(CLINICAL_SCHEMA, child)} {a} WHERE {a}.{fk} = "
                     f"{alias}.id), '[]'::jsonb)")
    body = ",\n      ".join(pairs)
    return (f"to_jsonb({alias}) || jsonb_build_object('_children', "
            f"jsonb_build_object(\n      {body}))")


def versioning_sql() -> str:
    cmap = child_map()
    out = ["-- Generated by tools/gen_db_rules.py - FHIR versioning. Do not edit by hand.", ""]
    for rtype, cls in sorted(FHIR_RESOURCES.items()):
        t = cls.__tablename__
        qt = _q(CLINICAL_SCHEMA, t)
        out += [
            f"CREATE OR REPLACE FUNCTION {CLINICAL_SCHEMA}.shri_snapshot_{t}(p_id uuid) "
            "RETURNS jsonb LANGUAGE sql STABLE AS $$",
            f"  SELECT {_children_expr(t, 'r', 1, cmap)}",
            f"  FROM {qt} r WHERE r.id = p_id",
            "$$;",
            f"CREATE TRIGGER trg_{t}_version BEFORE INSERT OR UPDATE ON {qt}",
            "  FOR EACH ROW EXECUTE FUNCTION shri_fhir_version();",
            f"CREATE CONSTRAINT TRIGGER trg_{t}_history AFTER INSERT OR UPDATE ON {qt}",
            "  DEFERRABLE INITIALLY DEFERRED",
            f"  FOR EACH ROW EXECUTE FUNCTION shri_fhir_history('{rtype}');",
            "",
        ]
    for name, cls in sorted(MAPPERS.items()):
        parents = getattr(cls, "fhir_parent", None)
        if not parents:
            continue
        args = []
        for col in parents:
            ptable = referenced_table(cls.__table__.c[col])
            if ptable.name in INSERT_ONLY:     # written once with its children; nothing to bump
                continue
            touch = "meta_last_updated" if "meta_version_id" in ptable.c else "updated_at"
            args += [col, ptable.name, touch]
        if not args:
            continue
        argstr = ", ".join(f"'{a}'" for a in args)
        qname = _q(_schema_of(cls.__table__), name)
        out += [f"CREATE TRIGGER trg_{name}_touch AFTER INSERT OR UPDATE OR DELETE ON {qname}",
                f"  FOR EACH ROW EXECUTE FUNCTION shri_fhir_touch_parent({argstr});"]
    cases = " ".join(f"WHEN '{r}' THEN '{c.__tablename__}'"
                     for r, c in sorted(FHIR_RESOURCES.items()))
    # Schema-qualified like the snapshot functions above: unqualified, the function landed in
    # whichever schema came first on the migrating role's search_path.
    out += ["",
            f"CREATE OR REPLACE FUNCTION {CLINICAL_SCHEMA}.shri_resource_table("
            "resource_type text) RETURNS text",
            f"LANGUAGE sql IMMUTABLE AS $$ SELECT CASE resource_type {cases} END $$;", ""]
    return "\n".join(out) + "\n"


def guards_sql() -> str:
    out = ["-- Generated by tools/gen_db_rules.py - attaches sql/10_rules.sql functions (and the",
           "-- rule functions later migrations add in their frozen SQL).", ""]
    for table, items in sorted(GUARDS.items()):
        qt = _q(_schema_of(MAPPERS[table].__table__), table)
        for suffix, when, fn in items:
            out.append(f"CREATE TRIGGER trg_{table}_{suffix} {when} ON {qt} "
                       f"FOR EACH ROW EXECUTE FUNCTION {fn};")
    for table, (suffix, fn) in sorted(DEFERRED.items()):
        qt = _q(_schema_of(MAPPERS[table].__table__), table)
        out.append(f"CREATE CONSTRAINT TRIGGER trg_{table}_{suffix} AFTER INSERT OR UPDATE ON "
                   f"{qt} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {fn};")
    for table, (fk, parent, editable) in sorted(FROZEN_CHILDREN.items()):
        qt = _q(_schema_of(MAPPERS[table].__table__), table)
        out.append(f"CREATE TRIGGER trg_{table}_frozen BEFORE INSERT OR UPDATE OR DELETE ON "
                   f"{qt} FOR EACH ROW EXECUTE FUNCTION "
                   f"shri_child_frozen_guard('{fk}', '{parent}', 'status', '{editable}');")
    # Notes on a signed prescription are frozen too (annotation is shared by many owners).
    out.append("CREATE TRIGGER trg_annotation_medreq_frozen BEFORE INSERT OR UPDATE OR DELETE "
               f"ON {_q(CLINICAL_SCHEMA, 'annotation')} FOR EACH ROW EXECUTE FUNCTION "
               "shri_child_frozen_guard("
               "'medication_request_id', 'medication_request', 'status', 'draft');")
    for table in sorted(INSERT_ONLY):
        qt = _q(_schema_of(MAPPERS[table].__table__), table)
        out.append(f"CREATE TRIGGER trg_{table}_insert_only BEFORE UPDATE OR DELETE ON {qt} "
                   "FOR EACH ROW EXECUTE FUNCTION shri_forbid_change();")
    for table in sorted(VERSIONED_TABLES):
        qt = _q(_schema_of(MAPPERS[table].__table__), table)
        out.append(f"CREATE TRIGGER trg_{table}_version BEFORE UPDATE ON {qt} "
                   "FOR EACH ROW EXECUTE FUNCTION shri_bump_version();")
    for tbl in sorted(Base.metadata.tables.values(), key=lambda t: t.name):
        if {"entry_source", "ai_suggestion_id"} <= set(tbl.c.keys()):
            qt = _q(_schema_of(tbl), tbl.name)
            out.append(f"CREATE TRIGGER trg_{tbl.name}_ai_provenance BEFORE INSERT OR UPDATE "
                       f"OF entry_source, ai_suggestion_id ON {qt} FOR EACH ROW EXECUTE "
                       "FUNCTION shri_ai_provenance_guard();")
    return "\n".join(out) + "\n"


def _grant(out: list[str], role: str, privs: list[str], qtable: str) -> None:
    if privs:
        out.append(f"GRANT {', '.join(privs)} ON {qtable} TO {role};")


def rls_sql(only: set[str] | None = None) -> str:
    """``only``: bare table names to (re)generate, for an incremental migration. ``None``
    (the default) regenerates the schema-level grants too."""
    own = f"tenant_id = {TENANT}"
    child_tables = {n for n, c in MAPPERS.items() if hasattr(c, "fhir_parent")}
    deletable = DELETABLE_ADMIN | child_tables
    out = ["-- Generated by tools/gen_db_rules.py - RLS and privileges. Do not edit by hand."]

    if only is None:
        out.append("")
        for schema in (CLINICAL_SCHEMA, ADMIN_SCHEMA, AUDIT_SCHEMA):
            out += [
                f"GRANT USAGE ON SCHEMA {schema} TO shri_app;",
                f"REVOKE ALL ON ALL TABLES IN SCHEMA {schema} FROM shri_app;",
                f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {schema} TO shri_app;",
            ]
        out += [
            f"GRANT USAGE ON SCHEMA {CLINICAL_SCHEMA} TO shri_fhir_reader;",
            f"REVOKE ALL ON ALL TABLES IN SCHEMA {CLINICAL_SCHEMA} FROM shri_fhir_reader;",
            f"GRANT USAGE ON SCHEMA {ADMIN_SCHEMA} TO shri_integration;",
            f"REVOKE ALL ON ALL TABLES IN SCHEMA {ADMIN_SCHEMA} FROM shri_integration;",
            f"GRANT USAGE ON SCHEMA {CLINICAL_SCHEMA} TO shri_integration;",
            f"REVOKE ALL ON ALL TABLES IN SCHEMA {CLINICAL_SCHEMA} FROM shri_integration;",
            # shri_reporting: role exists (created alongside the others) but has no table grants
            # yet - "approved views only" (D23), and no reporting views exist yet. Nothing to
            # grant until those views are built; adding USAGE now would be a no-op privilege
            # with nothing behind it, so it's deliberately left out.
            "",
        ]

    for table in sorted(Base.metadata.tables.values(), key=lambda t: t.name):
        name, schema = table.name, _schema_of(table)
        if only is not None and name not in only:
            continue
        qt = _q(schema, name)

        # --------------------------------------------------- shri_fhir_reader (clinical only)
        if schema == CLINICAL_SCHEMA:
            out.append(f"GRANT SELECT ON {qt} TO shri_fhir_reader;")

        # --------------------------------------------------- shri_integration
        if name in INTEGRATION_ADMIN_TABLES:
            _grant(out, "shri_integration", ["SELECT", "INSERT", "UPDATE"], qt)
        elif name in INTEGRATION_READ_TABLES:
            _grant(out, "shri_integration", ["SELECT"], qt)
        elif name in INTEGRATION_WRITE_TABLES:
            _grant(out, "shri_integration", ["INSERT", "UPDATE"], qt)

        # --------------------------------------------------- shri_app
        if name == "tenant":
            out += [f"ALTER TABLE {qt} ENABLE ROW LEVEL SECURITY;",
                    f"ALTER TABLE {qt} FORCE ROW LEVEL SECURITY;",
                    f"CREATE POLICY tenant_self ON {qt} USING (id = {TENANT});",
                    f"GRANT SELECT, UPDATE (name, legal_name, timezone, ai_enabled) "
                    f"ON {qt} TO shri_app;", ""]
            continue
        if name in GLOBAL_TABLES:
            out.append(f"GRANT SELECT ON {qt} TO shri_app;")
            continue
        if schema == AUDIT_SCHEMA:
            _grant(out, "shri_app", AUDIT_APP_PRIVS.get(name, ["INSERT"]), qt)
            if name == "audit_event":
                # INSERT alone isn't enough: SQLAlchemy's INSERT ... RETURNING (used to read
                # the server-generated id/recorded_at back into the ORM object) needs SELECT on
                # the columns it returns, even though the app otherwise never queries this
                # table directly. Column-restricted, not full SELECT - "insert only" stays true
                # for every other column (chain_seq, hash, prev_hash and the rest).
                out.append(f"GRANT SELECT (id, recorded_at) ON {qt} TO shri_app;")
            out += [f"ALTER TABLE {qt} ENABLE ROW LEVEL SECURITY;",
                    f"ALTER TABLE {qt} FORCE ROW LEVEL SECURITY;"]
            if table.c.tenant_id.nullable and name not in TENANT_ONLY:
                out += [f"CREATE POLICY tenant_read ON {qt} FOR SELECT "
                        f"USING (tenant_id IS NULL OR {own});",
                        f"CREATE POLICY tenant_write ON {qt} USING ({own}) WITH CHECK ({own});"]
            else:
                out.append(f"CREATE POLICY tenant_isolation ON {qt} USING ({own}) "
                           f"WITH CHECK ({own});")
            out.append("")
            continue

        privs = ["SELECT"]
        if name not in NO_APP_WRITE:
            privs.append("INSERT")
            if name not in INSERT_ONLY and name not in WRITE_ONCE:
                privs.append("UPDATE")
            if name in deletable and name not in INSERT_ONLY:
                privs.append("DELETE")
        out += [f"GRANT {', '.join(privs)} ON {qt} TO shri_app;",
                f"ALTER TABLE {qt} ENABLE ROW LEVEL SECURITY;",
                f"ALTER TABLE {qt} FORCE ROW LEVEL SECURITY;"]
        if table.c.tenant_id.nullable and name not in TENANT_ONLY:
            # Platform rows (tenant_id NULL) are readable; writes stay inside the tenant. Two
            # policies, because WITH CHECK does not apply to DELETE.
            out += [f"CREATE POLICY tenant_read ON {qt} FOR SELECT "
                    f"USING (tenant_id IS NULL OR {own});",
                    f"CREATE POLICY tenant_write ON {qt} USING ({own}) WITH CHECK ({own});"]
        else:
            out.append(f"CREATE POLICY tenant_isolation ON {qt} USING ({own}) "
                       f"WITH CHECK ({own});")
        out.append("")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- /fhir visibility
#: Restricted and very restricted charts (meta.security R, V; SECURITY_MODEL §5).
RESTRICTED_LABELS = ("R", "V")
#: Clinical resource tables with no patient: no patient column, no parent, nothing restricted
#: can sit below them. They are always visible on /fhir. Every other clinical table must get
#: a rule below, or the generator stops.
FHIR_PATIENTLESS = {"location", "medication", "organization", "practitioner",
                    "practitioner_role", "schedule"}
#: Tables that point at a resource of any type by (type column, id column), not by a key.
FHIR_POLYMORPHIC = {"fhir_resource_history": ("resource_type", "resource_id"),
                    "provenance": ("target_resource_type", "target_id")}


def _visible(table: str, alias: str, id_expr: str) -> str:
    # S608: SQL built from model names only; this generator never sees user input.
    return (f"EXISTS (SELECT 1 FROM {_q(CLINICAL_SCHEMA, table)} {alias} "  # noqa: S608
            f"WHERE {alias}.id = {id_expr})")


def _by_type(own_table: str, type_col: str, id_col: str) -> str:
    # A row about a resource of its own table's type (a provenance of a provenance) falls to
    # ELSE false and stays hidden: reading its own table from its own policy would recurse.
    whens = " ".join(f"WHEN '{rtype}' THEN {_visible(cls.__table__.name, 'v', id_col)}"
                     for rtype, cls in sorted(FHIR_RESOURCES.items())
                     if cls.__table__.name != own_table)
    return f"CASE {type_col} {whens} ELSE false END"


def fhir_visibility_rules() -> dict[str, str]:
    """Clinical table -> the condition under which shri_fhir_reader may see a row (D22).

    The patient is visible unless its chart is restricted. Every other row is visible only if
    each row it hangs off is visible to the same role: its patient, its parent row(s), or the
    resource a history or provenance row is about. The conditions are subqueries that run as
    shri_fhir_reader, so each one is filtered by the tables' own policies in turn, and a
    restricted chart disappears with everything below it. No function is involved, so the
    database never answers "is this patient restricted?" for the role.
    """
    labels = ", ".join(f"'{label}'" for label in RESTRICTED_LABELS)
    rules: dict[str, str] = {}
    for name, cls in sorted(MAPPERS.items()):
        table = cls.__table__
        if _schema_of(table) != CLINICAL_SCHEMA or name in FHIR_PATIENTLESS:
            continue
        if name == "patient":
            rules[name] = f"NOT (meta_security && ARRAY[{labels}]::varchar[])"
            continue
        if name in FHIR_POLYMORPHIC:
            rules[name] = _by_type(name, *FHIR_POLYMORPHIC[name])
            continue
        parts: list[str] = []
        pcol = patient_column(table)
        columns = ([pcol.name] if pcol is not None else []) + [
            c for c in getattr(cls, "fhir_parent", ()) if pcol is None or c != pcol.name]
        for col in columns:
            target = referenced_table(table.c[col]).name
            check = _visible(target, "v", f"{name}.{col}")
            parts.append(check if not table.c[col].nullable else f"({col} IS NULL OR {check})")
        if not parts:
            raise ValueError(f"clinical table {name} has no patient, parent or target: add it "
                             "to FHIR_PATIENTLESS only if nothing restricted can sit below it")
        rules[name] = " AND ".join(parts)
    for name, rule in rules.items():
        if f"FROM {_q(CLINICAL_SCHEMA, name)} " in rule:
            raise ValueError(f"the policy on {name} reads {name}: it would recurse forever")
    return rules


def fhir_lookup_denied_sql() -> str:
    """audit.record_fhir_lookup_denied: Thulasi's shape (#13, D22). Returns nothing and writes
    its own audit row, so /fhir never learns whether a chart was restricted or missing."""
    allowed = ", ".join(f"'{rtype}'" for rtype in sorted(FHIR_RESOURCES))
    labels = ", ".join(f"'{label}'" for label in RESTRICTED_LABELS)

    def lookup(type_var: str, id_var: str, *, follow_provenance: bool) -> str:
        whens = []
        for rtype, cls in sorted(FHIR_RESOURCES.items()):
            t = _q(CLINICAL_SCHEMA, cls.__table__.name)
            pcol = patient_column(cls.__table__)
            if rtype == "Patient":
                pick = "r.id, NULL, NULL"
            elif rtype == "Provenance" and follow_provenance:
                pick = "NULL, r.target_resource_type, r.target_id"
            else:
                pick = f"{'r.' + pcol.name if pcol is not None else 'NULL'}, NULL, NULL"
            # S608: SQL built from model names only; this generator never sees user input.
            whens.append(f"    WHEN '{rtype}' THEN\n"  # noqa: S608
                         f"      SELECT true, {pick} INTO v_found, v_patient, v_next_type, "
                         f"v_next_id\n        FROM {t} r WHERE r.id = {id_var};")
        return f"  CASE {type_var}\n" + "\n".join(whens) + "\n  END CASE;"

    # S608: SQL built from model names only; this generator never sees user input.
    return f"""-- Generated by tools/gen_db_rules.py - the /fhir denied-lookup audit. Do not edit.
-- Called by the /fhir facade when it cannot serve a resource ID it was asked for. It decides
-- here, as shri_migrator under the caller's clinic, whether the chart is restricted or the
-- resource does not exist, and writes the audit row itself. It returns nothing, so the
-- facade (and anyone who takes it over) cannot use it to learn which: the client gets the
-- same 404 either way (D22). Restricted: a security event (access denied). Not found: an
-- ordinary failed read, so the compliance officer's security log holds only restricted hits.
CREATE FUNCTION audit.record_fhir_lookup_denied(p_resource_type text, p_resource_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, clinical, audit AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_found boolean := false;
  v_patient uuid;
  v_next_type text;
  v_next_id uuid;
  v_restricted boolean := false;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no clinic set for this /fhir request' USING ERRCODE = '42501';
  END IF;
  IF p_resource_id IS NULL OR p_resource_type IS NULL
     OR p_resource_type NOT IN ({allowed}) THEN
    RAISE EXCEPTION 'not a /fhir resource type' USING ERRCODE = '22023';
  END IF;
{lookup('p_resource_type', 'p_resource_id', follow_provenance=True)}
  -- A provenance is restricted when the resource it is about is.
  IF v_next_type IN ({allowed}) AND v_next_type <> 'Provenance' THEN
{lookup('v_next_type', 'v_next_id', follow_provenance=False)}
  END IF;
  IF v_patient IS NOT NULL THEN
    SELECT p.meta_security && ARRAY[{labels}]::varchar[] INTO v_restricted
      FROM clinical.patient p WHERE p.id = v_patient;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, actor_type, actor_user_id, action, category,
                                 outcome, entity_type, entity_id, patient_id, purpose_of_use,
                                 reason, correlation_id)
  VALUES (v_tenant, CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END, v_user,
          CASE WHEN v_restricted THEN 'access-denied' ELSE 'read' END,
          CASE WHEN v_restricted THEN 'security' ELSE 'phi-read' END,
          CASE WHEN v_restricted THEN 'denied' ELSE 'failure' END,
          p_resource_type, p_resource_id::text,
          CASE WHEN v_restricted THEN v_patient END, 'TREAT',
          CASE WHEN v_restricted THEN 'restricted' ELSE 'not-found' END,
          left(NULLIF(current_setting('app.correlation_id', true), ''), 64));
END $$;
REVOKE EXECUTE ON FUNCTION audit.record_fhir_lookup_denied(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.record_fhir_lookup_denied(text, uuid) TO shri_fhir_reader;
"""  # noqa: S608


def fhir_visibility_sql() -> str:
    out = ["-- Generated by tools/gen_db_rules.py - what /fhir may see (D22). Do not edit by hand.",
           "-- RESTRICTIVE: combined with AND on top of the clinic policy, for shri_fhir_reader",
           "-- only. shri_app is unaffected: in the API, break-glass decides (D37).", ""]
    for name, rule in fhir_visibility_rules().items():
        out.append(f"CREATE POLICY fhir_hide_restricted ON {_q(CLINICAL_SCHEMA, name)} "
                   f"AS RESTRICTIVE FOR SELECT TO shri_fhir_reader USING ({rule});")
    return "\n".join(out) + "\n\n" + fhir_lookup_denied_sql()


def _lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def settings_seed_sql() -> str:
    """The platform settings catalogue (admin/core.py SETTINGS)."""
    out = [f"INSERT INTO {_q(ADMIN_SCHEMA, 'setting_definition')} "
           "(id, key, value_type, default_value, description) VALUES"]
    out.append(",\n".join(f"  (gen_random_uuid(), {_lit(k)}, {_lit(t.value)}, {_lit(d)}, "
                          f"{_lit(desc)})" for k, t, d, desc in SETTINGS)
               + "\nON CONFLICT (key) DO NOTHING;")
    return "\n".join(out) + "\n"


# Reference data only: code systems and the settings catalogue. Roles and permissions are not
# seeded: core's ROLE_PERMISSIONS (backend/app/core/permissions.py) is the only catalogue
# (Vimal, #45).
def seed_sql() -> str:
    cs = _q(ADMIN_SCHEMA, "code_system")
    out = ["-- Generated by tools/gen_db_rules.py - reference data.", ""]
    out.append(f"INSERT INTO {cs} (id, code, uri, name) VALUES")
    out.append(",\n".join(f"  (gen_random_uuid(), {_lit(c)}, {_lit(u)}, {_lit(n)})"
                          for c, u, n in systems.SEED) + "\nON CONFLICT DO NOTHING;")
    return "\n".join(out) + "\n\n" + settings_seed_sql()


def schema_sql() -> str:
    """DDL for every table, compiled by SQLAlchemy from the models (PostgreSQL dialect)."""
    from sqlalchemy import create_mock_engine

    stmts: list[str] = []

    def dump(sql: Any, *args: Any, **kwargs: Any) -> None:
        stmts.append(str(sql.compile(dialect=engine.dialect)).strip() + ";")

    engine = create_mock_engine("postgresql+psycopg://", dump)
    Base.metadata.create_all(engine, checkfirst=False)
    # A table's indexes, and the foreign keys added after all tables exist, come out in set
    # order, which changes from run to run. Sort each run of consecutive CREATE INDEX or
    # ALTER TABLE ... ADD CONSTRAINT statements (order within a run never matters) so the file
    # is the same every time.
    def kind(stmt: str) -> str:
        if stmt.startswith(("CREATE INDEX", "CREATE UNIQUE INDEX")):
            return "index"
        return "alter" if stmt.startswith("ALTER TABLE") and " ADD CONSTRAINT " in stmt else ""

    ordered: list[str] = []
    run: list[str] = []
    for stmt in stmts:
        if run and kind(stmt) != kind(run[0]):
            ordered += sorted(run) if kind(run[0]) else run
            run = []
        run.append(stmt)
    ordered += sorted(run) if run and kind(run[0]) else run
    return ("-- Generated by tools/gen_db_rules.py from the SQLAlchemy models. Do not edit.\n\n"
            + "\n\n".join(ordered) + "\n")


def main() -> None:
    files = {"01_schema.sql": schema_sql(), "20_fhir_versioning.sql": versioning_sql(),
             "30_guards.sql": guards_sql(),
             "90_rls_grants.sql": rls_sql(), "92_fhir_visibility.sql": fhir_visibility_sql(),
             "95_seed.sql": seed_sql()}
    for name, body in files.items():
        (ROOT / "sql" / name).write_text(body)
        print(f"wrote sql/{name} ({body.count(chr(10))} lines)", file=sys.stderr)


if __name__ == "__main__":
    main()
