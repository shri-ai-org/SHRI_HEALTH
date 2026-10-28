-- One coverage per patient per order at any time, for migration 0013 (from the reviews of
-- #121 to #123). Hand-written (names from the models). Frozen.
-- Same-order periods may not overlap (an open end is open-ended); entered-in-error coverages
-- don't count (D45). Ending a coverage (an end date) frees its order for the next period,
-- which one active coverage per order (0001's partial unique index) did not.
DROP INDEX clinical.uq_coverage_active_order;
ALTER TABLE clinical.coverage ADD CONSTRAINT ex_coverage_order_no_overlap EXCLUDE USING gist
  (beneficiary_patient_id WITH =, "order" WITH =,
   daterange(period_start, period_end, '[]') WITH &&)
  WHERE (status <> 'entered-in-error' AND "order" IS NOT NULL);
