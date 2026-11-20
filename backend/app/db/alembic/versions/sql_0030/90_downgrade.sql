-- Migration 0030 undone: each function back to its 0029 definition (pg_get_functiondef at
-- 0029, so without a SET clause where 0029 had none), then the helper dropped. Frozen.

CREATE OR REPLACE FUNCTION public.shri_ai_provenance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.entry_source = 'ai-generated' AND NOT EXISTS (
      SELECT 1 FROM ai_suggestion WHERE id = NEW.ai_suggestion_id
         AND decision IN ('accepted', 'edited')) THEN
    RAISE EXCEPTION '% row marked ai-generated needs an accepted or edited ai_suggestion (got %)',
      TG_TABLE_NAME, NEW.ai_suggestion_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_ai_suggestion_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_appointment_sync()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE appointment_participant SET updated_at = now() WHERE appointment_id = NEW.id;
  RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_audio_consent_check()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM consent c WHERE c.id = NEW.consent_id AND c.status = 'active'
                   AND (c.provision_period_start IS NULL OR c.provision_period_start <= now())
                   AND (c.provision_period_end IS NULL OR c.provision_period_end > now())) THEN
    RAISE EXCEPTION 'audio recording needs an active ambient-recording consent (consent %)',
      NEW.consent_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_audit_chain()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'clinical', 'admin', 'audit', 'public', 'pg_temp'
AS $function$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || coalesce(NEW.tenant_id::text, 'platform')));
  SELECT chain_seq, hash INTO last_seq, last_hash FROM audit_event
   WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND chain_seq IS NOT NULL
   ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash_version := 2;
  NEW.hash := encode(digest(shri_audit_payload(NEW), 'sha256'), 'hex');
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_child_frozen_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_composition_attester_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_composition_content_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_composition_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
                              ARRAY['status', 'verified_by_user_id', 'verified_at',
                                    'ext_cosign_status', 'ext_cosigner_practitioner_id',
                                    'ext_cosign_return_comment', 'ext_cosign_returned_at']
                              || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'signed note %: cannot change % (write an addendum or a replacing note)',
      OLD.id, array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  IF (OLD.ext_cosigner_practitioner_id IS NOT NULL
      AND NEW.ext_cosigner_practitioner_id IS DISTINCT FROM OLD.ext_cosigner_practitioner_id)
     OR (OLD.ext_cosign_status = 'cosigned'
         AND NEW.ext_cosign_status IS DISTINCT FROM 'cosigned') THEN
    RAISE EXCEPTION 'signed note %: its co-signer and a completed co-signature never change',
      OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_composition_signed_check()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_erx_order_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.medication_request_id IS NOT NULL
     AND (SELECT intent FROM medication_request WHERE id = NEW.medication_request_id)
         IS DISTINCT FROM 'order' THEN
    RAISE EXCEPTION 'medication request % is not a prescription; it is never sent',
      NEW.medication_request_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_fhir_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'clinical', 'admin', 'audit', 'public', 'pg_temp'
AS $function$
DECLARE ver int; snap jsonb; who_user uuid; who_patient uuid;
BEGIN
  EXECUTE format('SELECT meta_version_id, shri_snapshot_%s($1) FROM %I WHERE id = $1',
                 TG_TABLE_NAME, TG_TABLE_NAME) INTO ver, snap USING NEW.id;
  IF snap IS NULL THEN
    RETURN NULL;
  END IF;
  who_user := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  IF who_user IS NULL THEN
    who_patient := NULLIF(current_setting('app.current_patient_id', true), '')::uuid;
  END IF;
  INSERT INTO fhir_resource_history (tenant_id, resource_type, resource_id, version_id,
                                     recorded_by_user_id, recorded_by_patient_id, snapshot)
  VALUES (NEW.tenant_id, TG_ARGV[0], NEW.id, ver, who_user, who_patient, snap)
  ON CONFLICT (resource_type, resource_id, version_id) DO NOTHING;
  RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_fhir_touch_parent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_final_result_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_freeze_except()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE bad text[];
BEGIN
  bad := shri_changed_columns(to_jsonb(OLD), to_jsonb(NEW),
                              coalesce(TG_ARGV, '{}') || shri_meta_columns());
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION '% % is locked; cannot change: %', TG_TABLE_NAME, OLD.id,
      array_to_string(bad, ', ') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_medication_request_alert_check()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_medication_request_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_participant_sync()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.shri_service_request_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;

ALTER FUNCTION public.shri_bump_version() RESET search_path;
ALTER FUNCTION public.shri_fhir_version() RESET search_path;
ALTER FUNCTION public.shri_forbid_change() RESET search_path;
ALTER FUNCTION public.shri_provenance_target_check() RESET search_path;
ALTER FUNCTION audit.record_fhir_lookup_denied(text, uuid)
  SET search_path = pg_catalog, clinical, audit;
ALTER FUNCTION admin.portal_request_refill(uuid)
  SET search_path = clinical, admin, audit, public, pg_temp;

DROP FUNCTION public.shri_qualified_table(text);
