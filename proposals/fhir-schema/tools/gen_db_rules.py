"""Generate the model-derived SQL that migration 0002 freezes:

  sql/01_schema.sql           tables, keys, constraints and indexes (DDL compiled from models)
  sql/20_fhir_versioning.sql  snapshot functions + version / history / touch triggers
  sql/30_guards.sql           attaches the hand-written rule functions (sql/10_rules.sql)
  sql/90_rls_grants.sql       row-level security policies and privileges
  sql/95_seed.sql             code systems, permissions and system roles

Usage:  python -m tools.gen_db_rules          (writes the files above)

Migrations must stay frozen: after changing models, generate SQL for the new tables only and
paste it into the new revision (see README "Adding a table").
"""
from __future__ import annotations

import pathlib
import sys

from shri.models import FHIR_RESOURCES, GLOBAL_TABLES, MAPPERS, Base, systems

ROOT = pathlib.Path(__file__).resolve().parents[1]
TENANT = "NULLIF(current_setting('app.current_tenant_id', true), '')::uuid"

# Admin tables shri_app may DELETE from (configuration and draft lines). FHIR child tables are
# deletable too (guarded by their parent's state). Resource roots, financial, audit and
# integration rows are never deleted: they are corrected with a status.
DELETABLE_ADMIN = {
    "availability_rule_appointment_type", "care_team_member", "charge_diagnosis_pointer",
    "charge_modifier", "compendium_aoe_option", "compendium_aoe_question",
    "compendium_covered_diagnosis", "compendium_panel_member", "compendium_test_code",
    "eligibility_service_type", "fee_schedule_item", "integration_endpoint_setting",
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
}
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


def child_map() -> dict[str, list[tuple[str, str]]]:
    """parent table -> [(child table, fk column)] for FHIR child / datatype tables."""
    out: dict[str, list[tuple[str, str]]] = {}
    for name, cls in sorted(MAPPERS.items()):
        for col in getattr(cls, "fhir_parent", ()):
            fk = next(iter(cls.__table__.c[col].foreign_keys))
            out.setdefault(fk.column.table.name, []).append((name, col))
    return out


def _children_expr(table: str, alias: str, depth: int, cmap) -> str:
    kids = cmap.get(table, [])
    if not kids:
        return f"to_jsonb({alias})"
    names = [c for c, _ in kids]
    pairs = []
    for child, fk in kids:
        key = child if names.count(child) == 1 else f"{child}.{fk}"
        a = f"c{depth}"
        inner = _children_expr(child, a, depth + 1, cmap)
        pairs.append(f"'{key}', coalesce((SELECT jsonb_agg({inner} ORDER BY {a}.created_at, "
                     f"{a}.id) FROM {child} {a} WHERE {a}.{fk} = {alias}.id), '[]'::jsonb)")
    body = ",\n      ".join(pairs)
    return f"to_jsonb({alias}) || jsonb_build_object('_children', jsonb_build_object(\n      {body}))"


def versioning_sql() -> str:
    cmap = child_map()
    out = ["-- Generated by tools/gen_db_rules.py - FHIR versioning. Do not edit by hand.", ""]
    for rtype, cls in sorted(FHIR_RESOURCES.items()):
        t = cls.__tablename__
        out += [
            f"CREATE OR REPLACE FUNCTION shri_snapshot_{t}(p_id uuid) RETURNS jsonb "
            "LANGUAGE sql STABLE AS $$",
            f"  SELECT {_children_expr(t, 'r', 1, cmap)}",
            f"  FROM {t} r WHERE r.id = p_id",
            "$$;",
            f"CREATE TRIGGER trg_{t}_version BEFORE INSERT OR UPDATE ON {t}",
            "  FOR EACH ROW EXECUTE FUNCTION shri_fhir_version();",
            f"CREATE CONSTRAINT TRIGGER trg_{t}_history AFTER INSERT OR UPDATE ON {t}",
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
            ptable = next(iter(cls.__table__.c[col].foreign_keys)).column.table.name
            if ptable in INSERT_ONLY:     # written once with its children; nothing to bump
                continue
            touch = "meta_last_updated" if "meta_version_id" in Base.metadata.tables[ptable].c \
                else "updated_at"
            args += [col, ptable, touch]
        if not args:
            continue
        argstr = ", ".join(f"'{a}'" for a in args)
        out += [f"CREATE TRIGGER trg_{name}_touch AFTER INSERT OR UPDATE OR DELETE ON {name}",
                f"  FOR EACH ROW EXECUTE FUNCTION shri_fhir_touch_parent({argstr});"]
    cases = " ".join(f"WHEN '{r}' THEN '{c.__tablename__}'"
                     for r, c in sorted(FHIR_RESOURCES.items()))
    out += ["", "CREATE OR REPLACE FUNCTION shri_resource_table(resource_type text) RETURNS text",
            f"LANGUAGE sql IMMUTABLE AS $$ SELECT CASE resource_type {cases} END $$;", ""]
    return "\n".join(out) + "\n"


def guards_sql() -> str:
    out = ["-- Generated by tools/gen_db_rules.py - attaches sql/10_rules.sql functions.", ""]
    for table, items in sorted(GUARDS.items()):
        for suffix, when, fn in items:
            out.append(f"CREATE TRIGGER trg_{table}_{suffix} {when} ON {table} "
                       f"FOR EACH ROW EXECUTE FUNCTION {fn};")
    for table, (suffix, fn) in sorted(DEFERRED.items()):
        out.append(f"CREATE CONSTRAINT TRIGGER trg_{table}_{suffix} AFTER INSERT OR UPDATE ON "
                   f"{table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {fn};")
    for table, (fk, parent, editable) in sorted(FROZEN_CHILDREN.items()):
        out.append(f"CREATE TRIGGER trg_{table}_frozen BEFORE INSERT OR UPDATE OR DELETE ON "
                   f"{table} FOR EACH ROW EXECUTE FUNCTION "
                   f"shri_child_frozen_guard('{fk}', '{parent}', 'status', '{editable}');")
    # Notes on a signed prescription are frozen too (annotation is shared by many owners).
    out.append("CREATE TRIGGER trg_annotation_medreq_frozen BEFORE INSERT OR UPDATE OR DELETE "
               "ON annotation FOR EACH ROW EXECUTE FUNCTION shri_child_frozen_guard("
               "'medication_request_id', 'medication_request', 'status', 'draft');")
    for table in sorted(INSERT_ONLY):
        events = "UPDATE OR DELETE"
        out.append(f"CREATE TRIGGER trg_{table}_insert_only BEFORE {events} ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION shri_forbid_change();")
    for name, table in sorted(Base.metadata.tables.items()):
        if {"entry_source", "ai_suggestion_id"} <= set(table.c.keys()):
            out.append(f"CREATE TRIGGER trg_{name}_ai_provenance BEFORE INSERT OR UPDATE OF "
                       f"entry_source, ai_suggestion_id ON {name} FOR EACH ROW EXECUTE "
                       "FUNCTION shri_ai_provenance_guard();")
    return "\n".join(out) + "\n"


def rls_sql(only: set[str] | None = None) -> str:
    own = f"tenant_id = {TENANT}"
    child_tables = {n for n, c in MAPPERS.items() if hasattr(c, "fhir_parent")}
    deletable = DELETABLE_ADMIN | child_tables
    out = ["-- Generated by tools/gen_db_rules.py - RLS and privileges. Do not edit by hand."]
    if only is None:
        out += ["GRANT USAGE ON SCHEMA public TO shri_app;",
                "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM shri_app;",
                "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shri_app;", ""]
    for name, table in sorted(Base.metadata.tables.items()):
        if only is not None and name not in only:
            continue
        if name == "tenant":
            out += ["ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;",
                    "ALTER TABLE tenant FORCE ROW LEVEL SECURITY;",
                    f"CREATE POLICY tenant_self ON tenant USING (id = {TENANT});",
                    "GRANT SELECT, UPDATE (name, legal_name, timezone, ai_enabled) "
                    "ON tenant TO shri_app;", ""]
            continue
        if name in GLOBAL_TABLES:
            out.append(f"GRANT SELECT ON {name} TO shri_app;")
            continue
        privs = ["SELECT"]
        if name not in NO_APP_WRITE:
            privs.append("INSERT")
            if name not in INSERT_ONLY:
                privs.append("UPDATE")
            if name in deletable and name not in INSERT_ONLY:
                privs.append("DELETE")
        out += [f"GRANT {', '.join(privs)} ON {name} TO shri_app;",
                f"ALTER TABLE {name} ENABLE ROW LEVEL SECURITY;",
                f"ALTER TABLE {name} FORCE ROW LEVEL SECURITY;"]
        if table.c.tenant_id.nullable and name not in TENANT_ONLY:
            # Platform rows (tenant_id NULL) are readable; writes stay inside the tenant. Two
            # policies, because WITH CHECK does not apply to DELETE.
            out += [f"CREATE POLICY tenant_read ON {name} FOR SELECT "
                    f"USING (tenant_id IS NULL OR {own});",
                    f"CREATE POLICY tenant_write ON {name} USING ({own}) WITH CHECK ({own});"]
        else:
            out.append(f"CREATE POLICY tenant_isolation ON {name} USING ({own}) "
                       f"WITH CHECK ({own});")
        out.append("")
    return "\n".join(out) + "\n"


PERMISSIONS = [
    ("patient.read", "Read patient charts", True), ("patient.write", "Register and edit patients", True),
    ("patient.merge", "Merge and unmerge patients", True),
    ("chart.break_glass", "Open a restricted chart with a stated reason", True),
    ("schedule.manage", "Book, reschedule and cancel appointments", False),
    ("checkin.manage", "Check in, room and check out patients", False),
    ("note.write", "Draft clinical notes", True), ("note.sign", "Sign clinical notes", True),
    ("note.cosign", "Co-sign supervised notes", True),
    ("order.create", "Create and sign orders", True), ("result.acknowledge", "Acknowledge results", True),
    ("result.release", "Release results to the patient", True),
    ("rx.prescribe", "Sign prescriptions", True), ("rx.override_alert", "Override safety alerts", True),
    ("billing.manage", "Charges, claims and payments", False),
    ("eligibility.check", "Run eligibility checks", False),
    ("document.index", "File faxes and unindexed documents", False),
    ("ai.use", "Use AI drafting and summaries", True), ("ai.killswitch", "Disable AI features", False),
    ("admin.users", "Manage users and roles", False), ("admin.config", "Practice configuration", False),
    ("audit.review", "Review audit and break-the-glass reports", False),
    ("export.deidentified", "Run de-identified exports", False),
]
SYSTEM_ROLES = {
    "clinician": ("Clinician", ["patient.read", "patient.write", "note.write", "note.sign",
                                "note.cosign", "order.create", "result.acknowledge",
                                "result.release", "rx.prescribe", "rx.override_alert", "ai.use",
                                "chart.break_glass"]),
    "medical-assistant": ("Medical assistant", ["patient.read", "checkin.manage", "note.write",
                                                "ai.use"]),
    "front-desk": ("Front desk", ["schedule.manage", "checkin.manage", "eligibility.check",
                                  "document.index"]),
    "biller": ("Biller", ["billing.manage", "eligibility.check"]),
    "practice-admin": ("Practice administrator", ["admin.users", "admin.config",
                                                  "ai.killswitch", "audit.review",
                                                  "export.deidentified"]),
}


def seed_sql() -> str:
    q = lambda s: "'" + s.replace("'", "''") + "'"  # noqa: E731
    out = ["-- Generated by tools/gen_db_rules.py - reference data.", ""]
    out.append("INSERT INTO code_system (id, code, uri, name) VALUES")
    out.append(",\n".join(f"  (gen_random_uuid(), {q(c)}, {q(u)}, {q(n)})"
                          for c, u, n in systems.SEED) + "\nON CONFLICT DO NOTHING;")
    out.append("INSERT INTO permission (id, code, description, is_clinical) VALUES")
    out.append(",\n".join(f"  (gen_random_uuid(), {q(c)}, {q(d)}, {str(cl).lower()})"
                          for c, d, cl in PERMISSIONS) + "\nON CONFLICT DO NOTHING;")
    for code, (name, perms) in SYSTEM_ROLES.items():
        out.append(f"INSERT INTO role (id, tenant_id, code, name, is_system) VALUES "
                   f"(gen_random_uuid(), NULL, {q(code)}, {q(name)}, true) ON CONFLICT DO NOTHING;")
        out.append("INSERT INTO role_permission (role_id, permission_id, tenant_id) "
                   f"SELECT r.id, p.id, NULL FROM role r, permission p WHERE r.tenant_id IS NULL "
                   f"AND r.code = {q(code)} AND p.code IN ({', '.join(q(p) for p in perms)}) "
                   "ON CONFLICT DO NOTHING;")
    return "\n".join(out) + "\n"


def schema_sql() -> str:
    """DDL for every table, compiled by SQLAlchemy from the models (PostgreSQL dialect)."""
    from sqlalchemy import create_mock_engine

    stmts: list[str] = []

    def dump(sql, *args, **kwargs):
        stmts.append(str(sql.compile(dialect=engine.dialect)).strip() + ";")

    engine = create_mock_engine("postgresql+psycopg://", dump)
    Base.metadata.create_all(engine, checkfirst=False)
    return ("-- Generated by tools/gen_db_rules.py from the SQLAlchemy models. Do not edit.\n\n"
            + "\n\n".join(stmts) + "\n")


def main() -> None:
    files = {"01_schema.sql": schema_sql(), "20_fhir_versioning.sql": versioning_sql(), "30_guards.sql": guards_sql(),
             "90_rls_grants.sql": rls_sql(), "95_seed.sql": seed_sql()}
    for name, body in files.items():
        (ROOT / "sql" / name).write_text(body)
        print(f"wrote sql/{name} ({body.count(chr(10))} lines)", file=sys.stderr)


if __name__ == "__main__":
    main()
