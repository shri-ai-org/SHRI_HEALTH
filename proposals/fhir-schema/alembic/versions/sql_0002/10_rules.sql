-- Shri Health: database-enforced safety rules (hand-written; frozen into migration 0002).
-- Error code P0001 is raised for every rule violation so the API can map it to HTTP 409/422.

-- =============================================================================== helpers
CREATE OR REPLACE FUNCTION shri_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

-- Columns whose value differs between two row images, ignoring an allow-list.
CREATE OR REPLACE FUNCTION shri_changed_columns(o jsonb, n jsonb, allowed text[])
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(k ORDER BY k), '{}'::text[])
    FROM jsonb_object_keys(n) AS k
   WHERE k <> ALL (coalesce(allowed, '{}')) AND (o -> k) IS DISTINCT FROM (n -> k)
$$;

-- Columns every guard lets change: versioning metadata and audit columns.
CREATE OR REPLACE FUNCTION shri_meta_columns() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['meta_version_id', 'meta_last_updated', 'meta_txid', 'updated_at',
               'updated_by_user_id']
$$;

-- Generic lock: trigger arguments are the columns that may still change.
CREATE OR REPLACE FUNCTION shri_freeze_except() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text[];
BEGIN
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
                              coalesce(TG_ARGV, '{}') || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION '% % is locked; cannot change: %', TG_TABLE_NAME, OLD.id,
      array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================== FHIR versioning
-- meta.versionId increases once per transaction; meta.lastUpdated is always server time.
CREATE OR REPLACE FUNCTION shri_fhir_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.meta_version_id := 1;
    NEW.meta_txid := txid_current();
  ELSIF OLD.meta_txid IS DISTINCT FROM txid_current() THEN
    NEW.meta_version_id := OLD.meta_version_id + 1;
    NEW.meta_txid := txid_current();
  ELSE
    NEW.meta_version_id := OLD.meta_version_id;
    NEW.meta_txid := OLD.meta_txid;
  END IF;
  NEW.meta_last_updated := now();
  RETURN NEW;
END $$;

-- A change to a child row is a change to its resource: touch the parent so its version bumps.
-- Arguments come in triples: fk_column, parent_table, column_to_touch.
CREATE OR REPLACE FUNCTION shri_fhir_touch_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i int; pid uuid; img record;
BEGIN
  FOR i IN 0 .. (TG_NARGS / 3) - 1 LOOP
    FOREACH img IN ARRAY CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW] WHEN 'DELETE' THEN ARRAY[OLD]
                                    ELSE ARRAY[NEW, OLD] END LOOP
      EXECUTE format('SELECT ($1).%I', TG_ARGV[i * 3]) INTO pid USING img;
      IF pid IS NOT NULL THEN
        EXECUTE format('UPDATE %I SET %I = now() WHERE id = $1', TG_ARGV[i * 3 + 1],
                       TG_ARGV[i * 3 + 2]) USING pid;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

-- Snapshot each committed version into fhir_resource_history (constraint trigger, deferred to
-- commit so the snapshot holds the final state of the row and all its child rows).
-- SECURITY DEFINER: the API role cannot write history rows itself.
CREATE OR REPLACE FUNCTION shri_fhir_history() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ver int; snap jsonb;
BEGIN
  EXECUTE format('SELECT meta_version_id, shri_snapshot_%s($1) FROM %I WHERE id = $1',
                 TG_TABLE_NAME, TG_TABLE_NAME) INTO ver, snap USING NEW.id;
  IF snap IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO fhir_resource_history (tenant_id, resource_type, resource_id, version_id,
                                     recorded_by_user_id, snapshot)
  VALUES (NEW.tenant_id, TG_ARGV[0], NEW.id, ver,
          NULLIF(current_setting('app.current_user_id', true), '')::uuid, snap)
  ON CONFLICT (resource_type, resource_id, version_id) DO NOTHING;
  RETURN NULL;
END $$;

-- =============================================================================== child-row guards
-- SQL expression: was this row created in the current transaction? Resource tables know it
-- from their version metadata; other tables (superbill) never count as new.
CREATE OR REPLACE FUNCTION shri_created_in_this_tx_sql(tbl text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = tbl
                              AND column_name = 'meta_txid')
              THEN '(meta_version_id = 1 AND meta_txid = txid_current())'
              ELSE 'false' END
$$;

-- Blocks INSERT / UPDATE / DELETE of a child row while its parent is not in an editable state.
-- Arguments: fk_column, parent_table, status_column, editable statuses (comma separated).
-- A NULL fk (other owner of a shared datatype row) is ignored. A resource created in the
-- current transaction may be assembled with its children even if it was inserted as final
-- (lab results, imports); once committed, the state rule applies.
CREATE OR REPLACE FUNCTION shri_child_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; st text; img record; is_new boolean;
BEGIN
  FOREACH img IN ARRAY CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW] WHEN 'DELETE' THEN ARRAY[OLD]
                                  ELSE ARRAY[NEW, OLD] END LOOP
    EXECUTE format('SELECT ($1).%I', TG_ARGV[0]) INTO pid USING img;
    CONTINUE WHEN pid IS NULL;
    EXECUTE format('SELECT %I::text, %s FROM %I WHERE id = $1', TG_ARGV[2],
                   shri_created_in_this_tx_sql(TG_ARGV[1]), TG_ARGV[1])
      INTO st, is_new USING pid;
    IF st IS NOT NULL AND NOT is_new AND st <> ALL (string_to_array(TG_ARGV[3], ',')) THEN
      RAISE EXCEPTION '% % is %: its % rows cannot change', TG_ARGV[1], pid, st, TG_TABLE_NAME
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- =============================================================================== notes
-- Composition (clinical note): preliminary = draft; final / amended = signed and frozen.
CREATE OR REPLACE FUNCTION shri_composition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text[];
BEGIN
  IF OLD.status = 'preliminary' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'entered-in-error' OR NEW.status = 'preliminary' THEN
    bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW), shri_meta_columns());
    IF cardinality(bad) > 0 THEN
      RAISE EXCEPTION 'note % is % and cannot change (corrections are addenda)', OLD.id,
        OLD.status USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
                              ARRAY['status', 'verified_by_user_id', 'verified_at']
                              || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'signed note %: cannot change % (write an addendum or a replacing note)',
      OLD.id, array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- A note can be final only with a legal attester, and only if every AI-drafted section was
-- accepted or edited by a clinician (FRS §3.4: no AI content enters a signed record unreviewed).
CREATE OR REPLACE FUNCTION shri_composition_signed_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur record; bad_section uuid;
BEGIN
  SELECT status, entry_source INTO cur FROM composition WHERE id = NEW.id;
  IF cur.status NOT IN ('final', 'amended') OR cur.entry_source IN ('imported', 'interface') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM composition_attester WHERE composition_id = NEW.id
                  AND mode = 'legal') THEN
    RAISE EXCEPTION 'note % is % but has no legal attester (signature)', NEW.id, cur.status
      USING ERRCODE = 'P0001';
  END IF;
  SELECT s.id INTO bad_section FROM composition_section s
   WHERE s.composition_id = NEW.id AND s.ai_suggestion_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ai_suggestion a WHERE a.id = s.ai_suggestion_id
                      AND a.decision IN ('accepted', 'edited'))
   LIMIT 1;
  IF bad_section IS NOT NULL THEN
    RAISE EXCEPTION 'note % cannot be signed: AI-drafted section % was not accepted or edited',
      NEW.id, bad_section USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

-- Sections, entries, authors and relatesTo change only while the note is a draft (or in the
-- transaction that creates it, e.g. an imported signed note).
CREATE OR REPLACE FUNCTION shri_composition_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; st text; img record; is_new boolean;
BEGIN
  FOREACH img IN ARRAY CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW] WHEN 'DELETE' THEN ARRAY[OLD]
                                  ELSE ARRAY[NEW, OLD] END LOOP
    IF TG_TABLE_NAME = 'composition_section_entry' THEN
      SELECT composition_id INTO cid FROM composition_section WHERE id = img.section_id;
    ELSE
      cid := img.composition_id;
    END IF;
    SELECT status, meta_version_id = 1 AND meta_txid = txid_current() INTO st, is_new
      FROM composition WHERE id = cid;
    IF st IS NOT NULL AND st <> 'preliminary' AND NOT is_new THEN
      RAISE EXCEPTION 'note % is %: % cannot change', cid, st, TG_TABLE_NAME
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- Attestations are insert-only; a co-signature may be added after signing, not after
-- entered-in-error. The attesting user must be the attesting practitioner.
CREATE OR REPLACE FUNCTION shri_composition_attester_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM composition WHERE id = NEW.composition_id;
  IF st = 'entered-in-error' THEN
    RAISE EXCEPTION 'note % is entered-in-error; it cannot be attested', NEW.composition_id
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.ext_user_id
                  AND practitioner_id = NEW.party_practitioner_id) THEN
    RAISE EXCEPTION 'attester user % is not linked to practitioner %', NEW.ext_user_id,
      NEW.party_practitioner_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================== orders and Rx
-- Signed prescriptions (FR-MED-01/02): clinical content frozen; amend with priorPrescription.
CREATE OR REPLACE FUNCTION shri_medication_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text[];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION 'prescription % cannot return to draft', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('entered-in-error', 'cancelled', 'completed', 'stopped')
     AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'entered-in-error' THEN
    RAISE EXCEPTION 'prescription % is % (final state)', OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
           ARRAY['status', 'status_reason_system', 'status_reason_code', 'status_reason_display',
                 'status_reason_text', 'verified_by_user_id', 'verified_at']
           || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'signed prescription %: cannot change % (amend with a new request and priorPrescription)',
      OLD.id, array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- A prescription may become active only after every high-severity rule alert on it has a
-- mitigation (override reason) - FRS §3.4 alert tiers.
CREATE OR REPLACE FUNCTION shri_medication_request_alert_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE issue uuid;
BEGIN
  IF (SELECT status FROM medication_request WHERE id = NEW.id) <> 'active' THEN
    RETURN NULL;
  END IF;
  SELECT d.id INTO issue FROM detected_issue d
    JOIN detected_issue_implicated i ON i.detected_issue_id = d.id
   WHERE i.medication_request_id = NEW.id AND d.severity = 'high'
     AND d.status NOT IN ('cancelled', 'entered-in-error')
     AND NOT EXISTS (SELECT 1 FROM detected_issue_mitigation m WHERE m.detected_issue_id = d.id)
   LIMIT 1;
  IF issue IS NOT NULL THEN
    RAISE EXCEPTION 'prescription % has a high-severity alert % without an override reason',
      NEW.id, issue USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

-- Signed orders: clinical content frozen; only status / workflow columns move.
CREATE OR REPLACE FUNCTION shri_service_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text[];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION 'order % cannot return to draft', OLD.id USING ERRCODE = 'P0001';
  END IF;
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
           ARRAY['status', 'ext_fulfillment_status', 'ext_filler_order_number',
                 'ext_cancel_reason', 'verified_by_user_id', 'verified_at']
           || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'signed order %: cannot change %', OLD.id, array_to_string(bad, ', ')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- Final results (FR-ORD-02): a final result is never edited silently. Content changes require
-- the new status to say so (amended / corrected / appended); status never goes backwards.
-- Arguments: columns that may change without a correction status (acknowledgement, release).
CREATE OR REPLACE FUNCTION shri_final_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text[];
BEGIN
  IF OLD.status NOT IN ('final', 'amended', 'corrected', 'appended', 'entered-in-error') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'entered-in-error' THEN
    bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW), shri_meta_columns());
    IF cardinality(bad) > 0 THEN
      RAISE EXCEPTION '% % is entered-in-error and cannot change', TG_TABLE_NAME, OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IN ('registered', 'partial', 'preliminary') THEN
    RAISE EXCEPTION '% % is % and cannot go back to %', TG_TABLE_NAME, OLD.id, OLD.status,
      NEW.status USING ERRCODE = 'P0001';
  END IF;
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
           coalesce(TG_ARGV, '{}') || ARRAY['status', 'verified_by_user_id', 'verified_at']
           || shri_meta_columns());
  IF cardinality(bad) > 0 AND NEW.status NOT IN ('amended', 'corrected', 'appended',
                                                 'entered-in-error') THEN
    RAISE EXCEPTION '% % is final: record changes to % with status corrected or amended',
      TG_TABLE_NAME, OLD.id, array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(bad) > 0 AND NEW.status = OLD.status AND OLD.status <> 'final' THEN
    -- already corrected once: a further correction is still a new version (history keeps it)
    NULL;
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================== AI
-- AI output is immutable; the review decision is recorded once (FRS §3.4 traceability).
CREATE OR REPLACE FUNCTION shri_ai_suggestion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[] := ARRAY['target_id', 'updated_at', 'updated_by_user_id']; bad text[];
BEGIN
  IF OLD.decision = 'pending' THEN
    allowed := allowed || ARRAY['decision', 'decided_by_user_id', 'decided_at',
                                'edited_content', 'rejection_reason'];
  END IF;
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW), allowed);
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'ai_suggestion %: cannot change % (AI output is immutable, decisions are final)',
      OLD.id, array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  IF OLD.target_id IS NOT NULL AND NEW.target_id IS DISTINCT FROM OLD.target_id THEN
    RAISE EXCEPTION 'ai_suggestion % target is already set', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- A clinical row recorded as AI-generated must come from an accepted / edited suggestion.
CREATE OR REPLACE FUNCTION shri_ai_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entry_source = 'ai-generated' AND NOT EXISTS (
      SELECT 1 FROM ai_suggestion WHERE id = NEW.ai_suggestion_id
         AND decision IN ('accepted', 'edited')) THEN
    RAISE EXCEPTION '% row marked ai-generated needs an accepted or edited ai_suggestion (got %)',
      TG_TABLE_NAME, NEW.ai_suggestion_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- AI-01 audio requires an active ambient-recording consent of the same patient (the kind and
-- patient are pinned by composite FKs; status and validity window are checked here).
CREATE OR REPLACE FUNCTION shri_audio_consent_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM consent c WHERE c.id = NEW.consent_id AND c.status = 'active'
                   AND (c.provision_period_start IS NULL OR c.provision_period_start <= now())
                   AND (c.provision_period_end IS NULL OR c.provision_period_end > now())) THEN
    RAISE EXCEPTION 'audio recording needs an active ambient-recording consent (consent %)',
      NEW.consent_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================== scheduling
-- Keep appointment_participant.period / ext_blocking in step with the appointment, so the
-- exclusion constraint prevents double booking of a practitioner. Overbooks, appointment types
-- that allow overlap, inactive appointments and declined participants do not block.
CREATE OR REPLACE FUNCTION shri_participant_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  SELECT ap.start, ap."end", ap.status, ap.ext_overbook, coalesce(t.allow_overlap, false) AS ok
    INTO a FROM appointment ap LEFT JOIN appointment_type t ON t.id = ap.ext_appointment_type_id
   WHERE ap.id = NEW.appointment_id;
  NEW.period_start := a.start;
  NEW.period_end := a."end";
  NEW.ext_blocking := NEW.actor_practitioner_id IS NOT NULL AND a.start IS NOT NULL
                      AND a.status IN ('booked', 'arrived', 'checked-in', 'pending')
                      AND NOT a.ext_overbook AND NOT a.ok AND NEW.status <> 'declined';
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION shri_appointment_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE appointment_participant SET updated_at = now() WHERE appointment_id = NEW.id;
  RETURN NULL;
END $$;

-- =============================================================================== provenance
CREATE OR REPLACE FUNCTION shri_provenance_target_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tbl text := shri_resource_table(NEW.target_resource_type); found boolean;
BEGIN
  IF tbl IS NULL THEN
    RAISE EXCEPTION 'provenance target type % is not a stored FHIR resource',
      NEW.target_resource_type USING ERRCODE = 'P0001';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', tbl) INTO found
    USING NEW.target_id;
  IF NOT found THEN
    RAISE EXCEPTION 'provenance target %/% does not exist', NEW.target_resource_type,
      NEW.target_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================== audit chain
-- Canonical, timezone-independent payload covering every column.
CREATE OR REPLACE FUNCTION shri_audit_payload(e audit_event) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array('v1', e.chain_seq, e.prev_hash, e.event_uuid, e.tenant_id,
           to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           e.actor_type, e.actor_user_id, e.actor_display, e.action, e.outcome, e.entity_type,
           e.entity_id, e.entity_version_id, e.patient_id, e.purpose_of_use, e.reason,
           host(e.source_ip), e.user_agent, e.correlation_id)::text
$$;

-- chain_seq is assigned while holding the per-tenant lock. Use READ COMMITTED for audit
-- inserts: under REPEATABLE READ a stale snapshot fails on the unique (tenant, chain_seq).
CREATE OR REPLACE FUNCTION shri_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || coalesce(NEW.tenant_id::text, 'platform')));
  SELECT chain_seq, hash INTO last_seq, last_hash FROM audit_event
   WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND chain_seq IS NOT NULL
   ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := encode(digest(shri_audit_payload(NEW), 'sha256'), 'hex');
  RETURN NEW;
END $$;

-- One row per problem; no rows = chain intact.
CREATE OR REPLACE FUNCTION shri_audit_verify(p_tenant uuid)
RETURNS TABLE (seq bigint, audit_id bigint, problem text) LANGUAGE plpgsql STABLE AS $$
DECLARE r audit_event; prev text; expected bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_event a WHERE a.tenant_id IS NOT DISTINCT FROM p_tenant
            ORDER BY a.chain_seq LOOP
    IF r.chain_seq <> expected THEN
      seq := r.chain_seq; audit_id := r.id; problem := 'gap: expected chain_seq ' || expected;
      RETURN NEXT;
    END IF;
    IF r.prev_hash IS DISTINCT FROM prev THEN
      seq := r.chain_seq; audit_id := r.id; problem := 'prev_hash does not match the previous event';
      RETURN NEXT;
    END IF;
    IF r.hash IS DISTINCT FROM encode(digest(shri_audit_payload(r), 'sha256'), 'hex') THEN
      seq := r.chain_seq; audit_id := r.id; problem := 'hash mismatch: event content was altered';
      RETURN NEXT;
    END IF;
    prev := r.hash; expected := r.chain_seq + 1;
  END LOOP;
END $$;
