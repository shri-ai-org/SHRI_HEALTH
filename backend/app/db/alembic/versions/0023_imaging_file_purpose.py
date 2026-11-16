"""The imaging file purpose, server-made (issue #386; Anand's design, approved in principle).

An imaging report's illustrative image is a file with purpose ``imaging``, attached to its report
through ``clinical.diagnostic_report_presented_form``. Only the server makes one (the demo seed,
from images it checks against the SHA-256 in its manifest), so, like a receipt or an after-visit
summary, it is clean from the start and never scanned: the file service refuses an upload under
this purpose until a scanned upload path exists.

  ck_binary_object_purpose_codes      adds 'imaging'
  ck_binary_object_generated_clean    an imaging file is always clean
  ck_binary_object_clean_when_scanned an imaging file is clean without a scan

No table, column, policy, function or grant changes: shri_app already writes binary_object and
diagnostic_report_presented_form, and shri_portal still has no access to binary_object. The
downgrade refuses while any imaging file exists, then restores 0012's three constraints.

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-16
"""
from __future__ import annotations

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None

PURPOSES = ("'insurance-card', 'identity', 'receipt', 'encounter-audio', 'after-visit-summary', "
            "'document', 'fax', 'ccda', 'export', 'onboarding-import'")


def _constraints(purposes: str, generated: str) -> str:
    return f"""
ALTER TABLE admin.binary_object
  DROP CONSTRAINT ck_binary_object_purpose_codes,
  DROP CONSTRAINT ck_binary_object_generated_clean,
  DROP CONSTRAINT ck_binary_object_clean_when_scanned,
  ADD CONSTRAINT ck_binary_object_purpose_codes CHECK (purpose IN ({purposes})),
  ADD CONSTRAINT ck_binary_object_generated_clean
    CHECK (purpose NOT IN ({generated}) OR state = 'clean'),
  ADD CONSTRAINT ck_binary_object_clean_when_scanned
    CHECK (state <> 'clean' OR scan_status = 'clean' OR purpose IN ({generated}));
"""


def upgrade() -> None:
    op.execute(_constraints(PURPOSES + ", 'imaging'",
                            "'receipt', 'after-visit-summary', 'imaging'"))


def downgrade() -> None:
    # Every clinic's rows: row security unforced for this one check, as the owner, in the
    # migration's own transaction (as 0013's platform rules are written).
    op.execute("""
ALTER TABLE admin.binary_object NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM admin.binary_object WHERE purpose = 'imaging') THEN
    RAISE EXCEPTION 'imaging files exist: remove them before downgrading 0023'
      USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE admin.binary_object FORCE ROW LEVEL SECURITY;
""")
    op.execute(_constraints(PURPOSES, "'receipt', 'after-visit-summary'"))
