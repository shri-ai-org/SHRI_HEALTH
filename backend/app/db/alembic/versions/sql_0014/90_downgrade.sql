-- Migration 0014 undone: the purge functions, their policies and the index. Frozen.
DROP FUNCTION admin.delete_unusable_files(uuid[]);
DROP FUNCTION admin.list_unusable_files(integer);
DROP POLICY migrator_purge ON admin.binary_object;
DROP POLICY migrator_purge_read ON admin.binary_object;
DROP INDEX admin.ix_binary_object_unusable;
