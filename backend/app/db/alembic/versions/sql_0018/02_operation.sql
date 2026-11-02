-- shri_integration finishes the operations assigned to it through core's finish_operation
-- (app/core/long_running.py), for migration 0018. Hand-written, as 0005's grants here are.
-- finish_operation reads the operation back (its _COLUMNS) and sets updated_by_user_id, so the
-- worker needs those columns too. error is a catalogue Problem, never patient data. 0005's
-- RESTRICTIVE policy integration_assigned_only still limits it to the assigned rows, and the
-- table's clinic policy to the clinic it works in.
GRANT SELECT (created_by_user_id, created_at, updated_at, completed_at, result_type, result_id,
              error) ON admin.operation TO shri_integration;
GRANT UPDATE (updated_by_user_id) ON admin.operation TO shri_integration;
