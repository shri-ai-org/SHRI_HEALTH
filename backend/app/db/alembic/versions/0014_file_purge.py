"""The file service's purge: unusable files go, row and stored bytes (API_STANDARDS §15).

A file that is not clean 24 hours after its last change is unusable: an upload never completed
(`pending-upload`), a scan that never finished (`quarantined`) or a refused file (`rejected`).
Only a clean file is ever attached or downloaded, so nothing needs these. They go through two
SECURITY DEFINER functions, owned by shri_migrator with search_path pinned, as 0005's
admin.purge_expired_runtime_rows (D23: shri_maintenance has EXECUTE on purge functions only and
no table privileges; shri_app never has EXECUTE on them, and has no DELETE on binary_object):

  admin.list_unusable_files(p_limit)  the unusable files past the window, oldest first, as
                        (id, tenant_id, bucket, storage_key): what the job needs to delete each
                        stored object, and nothing else
  admin.delete_unusable_files(p_ids)  deletes the given rows that are still unusable and past
                        the window, each on its own; a row another table still references
                        (23503) is skipped, not an error. Returns the IDs it deleted.

The job (app.modules.files.purge, as shri_maintenance) lists, deletes the rows in a transaction,
deletes each deleted row's stored object, then commits, so a failure leaves at most a row whose
object is gone, which the next run removes, and a skipped row keeps its object. The window, 24
hours, is fixed here, so the caller can't shorten it; purge.PURGE_AFTER says the same.

RLS is forced, so it applies to shri_migrator too: narrow policies TO shri_migrator let it see and
delete exactly the unusable rows past the window, as 0005's do.

Also the partial index ix_binary_object_unusable (updated_at, id) WHERE state <> 'clean', for the
listing (as generated).

Frozen SQL in sql_0014/:
  01_file_purge.sql     the index (as generated), the policies and the functions (hand-written)
  90_downgrade.sql      all of it dropped

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-28
"""
from __future__ import annotations

import pathlib

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None

SQL_DIR = pathlib.Path(__file__).with_name("sql_0014")


def upgrade() -> None:
    op.execute((SQL_DIR / "01_file_purge.sql").read_text())


def downgrade() -> None:
    op.execute((SQL_DIR / "90_downgrade.sql").read_text())
