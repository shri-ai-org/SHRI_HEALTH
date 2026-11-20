"""Secure messaging: a portal thread is a `patient-message` inbox item, its messages are the
item's replies (#398's listPortalMessageThreads, createPortalMessage, getPortalMessageThread,
replyToPortalMessageThread and replyToInboxItem; D77, D81, D84; Anand's go, 20 Nov).

  admin.work_item
      `patient-message` joins the item types. ck_work_item_patient_message: such an item has a
      patient, the subject as its title (3 to 200 characters), no body (its text is in replies,
      which never change) and no other record. trg_work_item_patient_message: only the portal's
      functions make one (never a staff insert), and its type, patient, title and body never
      change; once completed or cancelled (the portal's "closed") it stays closed.
  admin.work_item_reply
      One reply on an item's thread: a staff member's or, on a `patient-message` item, the
      patient's own (exactly one author). Body 1 to 4,000 characters. `to_patient`: a staff
      reply the patient reads; the patient's own replies are always true. Same-clinic item, and
      a patient's reply only on her own item (composite keys). Insert-only for every role.
      Forced row security under the clinic policy, and no service role holds any privilege on
      it: only the functions below, owned by shri_migrator, read and write it.

  Every function: SECURITY DEFINER, owner shri_migrator, search_path pinned to pg_catalog,
  pg_temp with every name schema-qualified, nothing for PUBLIC, EXECUTE for one role. The clinic,
  the patient and the staff user come from the session settings, never from an argument.

  shri_portal (each refuses or finds nothing without a session patient):
    admin.portal_message_threads(p_limit, p_offset)  the session patient's threads, latest
        activity first: subject, open/closed, times, who wrote last. No message text.
    admin.portal_message_thread(p_thread_id)  one thread's messages the patient may read (her
        own and to_patient replies), oldest first, the staff member's display name on clinic
        ones. Another patient's thread gives no rows, as a missing one does (404).
    admin.portal_create_message(p_subject, p_body)  the item, routed to the clinic's medical
        assistants (role MA) at the facility of the patient's latest visit, else the clinic's
        first active facility; its `created` event; the first reply; and inbox.item-assigned for
        the role, carrying only the item's type and priority (D81). Returns the thread ID.
    admin.portal_reply_to_thread(p_thread_id, p_body)  the patient's reply on her own open
        thread, and inbox.item-assigned for whoever holds the item. Returns the reply ID.
    Refusals (SQLSTATE, constraint name; the service maps them): P0002 no such thread of the
    session patient (404); P0001 portal_message_thread_closed (409 invalid-state-transition),
    portal_message_thread_full (409, the contract's 500 messages), portal_message_chart_inactive
    (403), portal_message_rate_limited (more than 5 messages in 10 minutes) and
    portal_message_daily_cap (more than 20 in 24 hours), both 429; portal_message_no_queue (the
    clinic has no active facility). The patient's messages are counted under a per-patient lock.
  shri_app:
    admin.inbox_reply(p_item_id, p_body, p_to_patient)  a reply by the session's staff user (an
        active user of the clinic) on an open item. to_patient only on a `patient-message` item.
        It never writes a patient's reply. Refusals: P0002 (404); P0001 inbox_item_closed (409),
        inbox_reply_to_patient_not_allowed (422), inbox_reply_not_staff (403).
    admin.inbox_replies(p_item_id)  an item's replies, oldest first, for the inbox service, which
        applies the item's visibility and the restricted-chart rules (D37) before showing them.

Nothing here logs or raises message text; error messages carry no subject, body or name.

Revision ID: 0031
Revises: 0029 (0030 is #463; whichever merges second takes the other as its parent)
Create Date: 2026-11-20
"""
from __future__ import annotations

from alembic import op

revision = "0031"
down_revision = "0029"
branch_labels = None
depends_on = None

TYPES = ("'result-review', 'refill-request', 'message', 'task', 'document-review', "
         "'unsigned-note', 'cosign', 'fax-indexing', 'unmatched-result', 'eligibility', "
         "'claim-rejection', 'rooming'")
SUBJECTS = ("diagnostic_report_id, composition_id, document_reference_id, medication_request_id, "
            "service_request_id, appointment_id, unmatched_result_id, claim_id, "
            "fax_transmission_id")
TENANT = "NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid"
PATIENT = "NULLIF(pg_catalog.current_setting('app.current_patient_id', true), '')::uuid"
USER = "NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')::uuid"

TABLES = f"""
ALTER TABLE admin.work_item DROP CONSTRAINT ck_work_item_item_type_codes;
ALTER TABLE admin.work_item ADD CONSTRAINT ck_work_item_item_type_codes
  CHECK (item_type IN ({TYPES}, 'patient-message'));
ALTER TABLE admin.work_item ADD CONSTRAINT ck_work_item_patient_message
  CHECK (item_type <> 'patient-message' OR (patient_id IS NOT NULL AND body IS NULL
         AND char_length(title) >= 3 AND encounter_id IS NULL AND num_nonnulls({SUBJECTS}) = 0));

CREATE TABLE admin.work_item_reply (
  work_item_id uuid NOT NULL,
  author_user_id uuid,
  author_patient_id uuid,
  body text NOT NULL,
  to_patient boolean DEFAULT false NOT NULL,
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  created_by_user_id uuid,
  updated_by_user_id uuid,
  CONSTRAINT pk_work_item_reply PRIMARY KEY (id),
  CONSTRAINT ck_work_item_reply_one_author
    CHECK (num_nonnulls(author_user_id, author_patient_id) = 1),
  CONSTRAINT ck_work_item_reply_body CHECK (char_length(body) BETWEEN 1 AND 4000),
  CONSTRAINT ck_work_item_reply_patient_sees_own CHECK (author_patient_id IS NULL OR to_patient),
  CONSTRAINT fk_work_item_reply_item_same_tenant FOREIGN KEY (tenant_id, work_item_id)
    REFERENCES admin.work_item (tenant_id, id),
  CONSTRAINT fk_work_item_reply_patient_own_item FOREIGN KEY (author_patient_id, work_item_id)
    REFERENCES admin.work_item (patient_id, id),
  CONSTRAINT fk_work_item_reply_author_user_id_app_user FOREIGN KEY (author_user_id)
    REFERENCES admin.app_user (id),
  CONSTRAINT fk_work_item_reply_author_patient_id_patient FOREIGN KEY (author_patient_id)
    REFERENCES clinical.patient (id),
  CONSTRAINT fk_work_item_reply_author_patient_id_tenant FOREIGN KEY (tenant_id,
    author_patient_id) REFERENCES clinical.patient (tenant_id, id),
  CONSTRAINT fk_work_item_reply_tenant_id_tenant FOREIGN KEY (tenant_id)
    REFERENCES admin.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_item_reply_created_by_user_id_app_user FOREIGN KEY (created_by_user_id)
    REFERENCES admin.app_user (id) ON DELETE SET NULL,
  CONSTRAINT fk_work_item_reply_updated_by_user_id_app_user FOREIGN KEY (updated_by_user_id)
    REFERENCES admin.app_user (id) ON DELETE SET NULL
);
CREATE INDEX ix_work_item_reply_tenant_id ON admin.work_item_reply (tenant_id);
CREATE INDEX ix_work_item_reply_thread ON admin.work_item_reply (tenant_id, work_item_id,
                                                                  created_at);
CREATE INDEX ix_work_item_reply_patient_recent ON admin.work_item_reply
  (tenant_id, author_patient_id, created_at) WHERE author_patient_id IS NOT NULL;
CREATE TRIGGER trg_work_item_reply_insert_only BEFORE UPDATE OR DELETE ON admin.work_item_reply
  FOR EACH ROW EXECUTE FUNCTION public.shri_forbid_change();
ALTER TABLE admin.work_item_reply ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.work_item_reply FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin.work_item_reply USING (tenant_id = {TENANT})
  WITH CHECK (tenant_id = {TENANT});
REVOKE ALL ON admin.work_item_reply FROM PUBLIC;
"""

# Runs as whoever writes work_item: a staff insert or edit runs as shri_app, the portal's
# functions as their owner, shri_migrator.
GUARD = """
CREATE FUNCTION admin.shri_patient_message_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.item_type = 'patient-message' AND current_user <> 'shri_migrator' THEN
      RAISE EXCEPTION 'only the patient portal starts a patient message'
        USING ERRCODE = 'P0001', CONSTRAINT = 'patient_message_portal_only';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.item_type = 'patient-message' OR NEW.item_type = 'patient-message')
     AND (NEW.item_type IS DISTINCT FROM OLD.item_type
          OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
          OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
          OR (OLD.status IN ('completed', 'cancelled') AND NEW.status <> OLD.status)) THEN
    RAISE EXCEPTION 'a patient message keeps its type, patient and subject, and stays closed'
      USING ERRCODE = 'P0001', CONSTRAINT = 'patient_message_unchanged';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION admin.shri_patient_message_guard() OWNER TO shri_migrator;
REVOKE ALL ON FUNCTION admin.shri_patient_message_guard() FROM PUBLIC;
CREATE TRIGGER trg_work_item_patient_message BEFORE INSERT OR UPDATE ON admin.work_item
  FOR EACH ROW EXECUTE FUNCTION admin.shri_patient_message_guard();
"""

# The patient's limits (inside the functions, under a per-patient lock): at most 5 messages in
# 10 minutes and 20 in 24 hours, new threads and replies together.
LIMITS = """
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('portal-message'),
                                           pg_catalog.hashtext(v_patient::text));
  IF (SELECT count(*) FROM admin.work_item_reply r WHERE r.tenant_id = v_tenant
         AND r.author_patient_id = v_patient AND r.created_at > now() - interval '10 minutes') >= 5
  THEN
    RAISE EXCEPTION 'too many messages; try again later'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_message_rate_limited';
  END IF;
  IF (SELECT count(*) FROM admin.work_item_reply r WHERE r.tenant_id = v_tenant
         AND r.author_patient_id = v_patient AND r.created_at > now() - interval '24 hours') >= 20
  THEN
    RAISE EXCEPTION 'the daily message limit is reached'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_message_daily_cap';
  END IF;"""

# inbox.item-assigned for the item's holder: its user, or its role's users at its facility. Only
# the type and priority travel (D81; EVENTS.md §4).
ASSIGNED_EVENT = """
  INSERT INTO admin.event_log (id, tenant_id, facility_id, patient_id, target_user_id,
                               target_role_code, type, subject, data)
  SELECT gen_random_uuid(), w.tenant_id, w.facility_id, w.patient_id, w.assigned_user_id,
         r.code, 'inbox.item-assigned', 'inbox-item/' || w.id::text,
         jsonb_build_object('itemType', w.item_type, 'priority', 'routine')
    FROM admin.work_item w LEFT JOIN admin.role r ON r.id = w.assigned_role_id
   WHERE w.id = v_item AND (w.assigned_user_id IS NOT NULL OR r.code ~ '^[A-Z]{2,10}$');"""

# S608: every piece put into this SQL is a constant of this file.
PORTAL = f"""
CREATE FUNCTION admin.portal_message_threads(p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, subject text, status text, created_at timestamptz,
               last_message_at timestamptz, last_message_from text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.id, w.title::text,
         CASE WHEN w.status IN ('completed', 'cancelled') THEN 'closed' ELSE 'open' END,
         w.created_at, l.created_at,
         CASE WHEN l.author_patient_id IS NULL THEN 'clinic' ELSE 'patient' END
    FROM admin.work_item w
    CROSS JOIN LATERAL (SELECT r.created_at, r.author_patient_id FROM admin.work_item_reply r
                         WHERE r.tenant_id = w.tenant_id AND r.work_item_id = w.id
                           AND r.to_patient ORDER BY r.created_at DESC, r.id DESC LIMIT 1) l
   WHERE w.tenant_id = {TENANT} AND w.patient_id = {PATIENT}
     AND w.item_type = 'patient-message'
   ORDER BY l.created_at DESC, w.id DESC
   LIMIT least(greatest(coalesce(p_limit, 25), 1), 101) OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

CREATE FUNCTION admin.portal_message_thread(p_thread_id uuid)
RETURNS TABLE (thread_id uuid, subject text, status text, created_at timestamptz,
               message_id uuid, author text, author_name text, body text, sent_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.id, w.title::text,
         CASE WHEN w.status IN ('completed', 'cancelled') THEN 'closed' ELSE 'open' END,
         w.created_at, r.id,
         CASE WHEN r.author_patient_id IS NULL THEN 'clinic' ELSE 'patient' END,
         u.display_name::text, r.body, r.created_at
    FROM admin.work_item w
    JOIN admin.work_item_reply r ON r.tenant_id = w.tenant_id AND r.work_item_id = w.id
                                AND r.to_patient
    LEFT JOIN admin.app_user u ON u.id = r.author_user_id
   WHERE w.id = p_thread_id AND w.tenant_id = {TENANT} AND w.patient_id = {PATIENT}
     AND w.item_type = 'patient-message'
   ORDER BY r.created_at, r.id
   LIMIT 500
$$;

CREATE FUNCTION admin.portal_create_message(p_subject text, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := {TENANT};
  v_patient uuid := {PATIENT};
  v_item uuid := gen_random_uuid();
  v_facility uuid;
  v_role uuid;
BEGIN
  IF v_tenant IS NULL OR v_patient IS NULL THEN
    RAISE EXCEPTION 'no portal patient' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clinical.patient p WHERE p.id = v_patient
                    AND p.tenant_id = v_tenant AND p.active) THEN
    RAISE EXCEPTION 'this chart is not active'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_message_chart_inactive';
  END IF;{LIMITS}
  SELECT a.ext_facility_id INTO v_facility FROM clinical.appointment a
    JOIN admin.facility f ON f.id = a.ext_facility_id AND f.is_active
   WHERE a.tenant_id = v_tenant AND a.subject_patient_id = v_patient
     AND a.status NOT IN ('cancelled', 'entered-in-error')
   ORDER BY a.start DESC NULLS LAST, a.id LIMIT 1;
  IF v_facility IS NULL THEN
    SELECT f.id INTO v_facility FROM admin.facility f
     WHERE f.tenant_id = v_tenant AND f.is_active ORDER BY f.code, f.id LIMIT 1;
  END IF;
  SELECT r.id INTO v_role FROM admin.role r
   WHERE r.code = 'MA' AND (r.tenant_id = v_tenant OR r.tenant_id IS NULL)
   ORDER BY r.tenant_id NULLS LAST LIMIT 1;
  IF v_facility IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'no queue for patient messages' USING ERRCODE = 'P0001',
      CONSTRAINT = 'portal_message_no_queue';
  END IF;
  INSERT INTO admin.work_item (id, tenant_id, item_type, status, priority, title,
                               assigned_role_id, facility_id, escalation_level, patient_id)
  VALUES (v_item, v_tenant, 'patient-message', 'open', 4, p_subject, v_role, v_facility, 0,
          v_patient);
  INSERT INTO admin.work_item_event (id, tenant_id, work_item_id, event, to_status, occurred_at)
  VALUES (gen_random_uuid(), v_tenant, v_item, 'created', 'open', now());
  INSERT INTO admin.work_item_reply (id, tenant_id, work_item_id, author_patient_id, body,
                                     to_patient)
  VALUES (gen_random_uuid(), v_tenant, v_item, v_patient, p_body, true);{ASSIGNED_EVENT}
  RETURN v_item;
END $$;

CREATE FUNCTION admin.portal_reply_to_thread(p_thread_id uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := {TENANT};
  v_patient uuid := {PATIENT};
  v_item uuid;
  v_status text;
  v_reply uuid := gen_random_uuid();
BEGIN
  SELECT w.id, w.status INTO v_item, v_status FROM admin.work_item w
   WHERE w.id = p_thread_id AND w.tenant_id = v_tenant AND w.patient_id = v_patient
     AND w.item_type = 'patient-message' FOR UPDATE;
  IF v_item IS NULL OR v_tenant IS NULL OR v_patient IS NULL THEN
    RAISE EXCEPTION 'thread not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'this thread is closed; start a new message'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_message_thread_closed';
  END IF;
  IF (SELECT count(*) FROM admin.work_item_reply r WHERE r.tenant_id = v_tenant
         AND r.work_item_id = v_item AND r.to_patient) >= 500 THEN
    RAISE EXCEPTION 'this thread is full; start a new message'
      USING ERRCODE = 'P0001', CONSTRAINT = 'portal_message_thread_full';
  END IF;{LIMITS}
  INSERT INTO admin.work_item_reply (id, tenant_id, work_item_id, author_patient_id, body,
                                     to_patient)
  VALUES (v_reply, v_tenant, v_item, v_patient, p_body, true);
  UPDATE admin.work_item SET updated_at = now() WHERE id = v_item;{ASSIGNED_EVENT}
  RETURN v_reply;
END $$;
"""  # noqa: S608

STAFF = f"""
CREATE FUNCTION admin.inbox_reply(p_item_id uuid, p_body text, p_to_patient boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := {TENANT};
  v_user uuid := {USER};
  v_type text;
  v_status text;
  v_reply uuid := gen_random_uuid();
BEGIN
  SELECT w.item_type, w.status INTO v_type, v_status FROM admin.work_item w
   WHERE w.id = p_item_id AND w.tenant_id = v_tenant FOR UPDATE;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM admin.app_user u WHERE u.id = v_user AND u.tenant_id = v_tenant
                    AND u.is_active) THEN
    RAISE EXCEPTION 'only a staff member of this clinic replies here'
      USING ERRCODE = 'P0001', CONSTRAINT = 'inbox_reply_not_staff';
  END IF;
  IF v_status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'this item is closed'
      USING ERRCODE = 'P0001', CONSTRAINT = 'inbox_item_closed';
  END IF;
  IF coalesce(p_to_patient, false) AND v_type <> 'patient-message' THEN
    RAISE EXCEPTION 'only a patient message is answered to the patient'
      USING ERRCODE = 'P0001', CONSTRAINT = 'inbox_reply_to_patient_not_allowed';
  END IF;
  INSERT INTO admin.work_item_reply (id, tenant_id, work_item_id, author_user_id, body,
                                     to_patient, created_by_user_id)
  VALUES (v_reply, v_tenant, p_item_id, v_user, p_body, coalesce(p_to_patient, false), v_user);
  UPDATE admin.work_item SET updated_at = now(), updated_by_user_id = v_user
   WHERE id = p_item_id;
  RETURN v_reply;
END $$;

CREATE FUNCTION admin.inbox_replies(p_item_id uuid)
RETURNS TABLE (id uuid, author_user_id uuid, author_name text, from_patient boolean,
               to_patient boolean, body text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.id, r.author_user_id, u.display_name::text, r.author_patient_id IS NOT NULL,
         r.to_patient, r.body, r.created_at
    FROM admin.work_item_reply r LEFT JOIN admin.app_user u ON u.id = r.author_user_id
   WHERE r.work_item_id = p_item_id AND r.tenant_id = {TENANT}
   ORDER BY r.created_at, r.id
   LIMIT 500
$$;
"""  # noqa: S608

FUNCTIONS = {
    "admin.portal_message_threads(integer, integer)": "shri_portal",
    "admin.portal_message_thread(uuid)": "shri_portal",
    "admin.portal_create_message(text, text)": "shri_portal",
    "admin.portal_reply_to_thread(uuid, text)": "shri_portal",
    "admin.inbox_reply(uuid, text, boolean)": "shri_app",
    "admin.inbox_replies(uuid)": "shri_app",
}


def upgrade() -> None:
    op.execute(TABLES)
    op.execute(GUARD)
    op.execute(PORTAL)
    op.execute(STAFF)
    for function, role in FUNCTIONS.items():
        op.execute(f"ALTER FUNCTION {function} OWNER TO shri_migrator; "
                   f"REVOKE ALL ON FUNCTION {function} FROM PUBLIC; "
                   f"GRANT EXECUTE ON FUNCTION {function} TO {role};")


def downgrade() -> None:
    # Messages are part of the record: refuse rather than drop them. Every clinic's rows count,
    # so the owner looks without forced row security, inside this transaction only.
    op.execute("""
ALTER TABLE admin.work_item NO FORCE ROW LEVEL SECURITY;
ALTER TABLE admin.work_item_reply NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM admin.work_item WHERE item_type = 'patient-message')
     OR EXISTS (SELECT 1 FROM admin.work_item_reply) THEN
    RAISE EXCEPTION 'messages exist; 0031 cannot be downgraded';
  END IF;
END $$;
ALTER TABLE admin.work_item FORCE ROW LEVEL SECURITY;""")
    for function in FUNCTIONS:
        op.execute(f"DROP FUNCTION {function}")
    op.execute(f"""
DROP TRIGGER trg_work_item_patient_message ON admin.work_item;
DROP FUNCTION admin.shri_patient_message_guard();
DROP TABLE admin.work_item_reply;
ALTER TABLE admin.work_item DROP CONSTRAINT ck_work_item_patient_message;
ALTER TABLE admin.work_item DROP CONSTRAINT ck_work_item_item_type_codes;
ALTER TABLE admin.work_item ADD CONSTRAINT ck_work_item_item_type_codes
  CHECK (item_type IN ({TYPES}));
""")
