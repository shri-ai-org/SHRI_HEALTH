"""The file service's core settings (Anand's ask on #13): where file bytes live, and the scanner.

Either a folder (FILE_STORE_DIR, development and tests) or the object store (SeaweedFS's S3 API:
every FILE_STORE_* below but the folder). A half-configured object store stops startup naming
what is missing (Settings._object_store_complete). The file service reads these in place of its
temporary SHRI_FILE_STORE_DIR, SHRI_S3_* and CLAMD_ADDRESS variables (#128).
"""

from pydantic import SecretStr
from pydantic_settings import BaseSettings

# Set together, or not at all.
OBJECT_STORE_FIELDS = ("file_store_url", "file_store_access_key_id",
                       "file_store_secret_access_key", "file_store_clean_bucket",
                       "file_store_quarantine_bucket")


class FilesFields(BaseSettings):
    # A folder for development and tests only: files there are as safe as the disk.
    file_store_dir: str | None = None
    # The object store: where the API reaches it, where browsers reach it for upload links
    # (default: the same), and the API's own access key, never a root key.
    file_store_url: str | None = None
    file_store_public_url: str | None = None
    file_store_region: str = "us-east-1"
    file_store_access_key_id: str | None = None
    file_store_secret_access_key: SecretStr | None = None
    # The real bucket names behind the logical `clean` and `quarantine`.
    file_store_clean_bucket: str | None = None
    file_store_quarantine_bucket: str | None = None
    # clamd, for the upload scan: host:port, tcp://host:port or unix:///path. Unset: every scan
    # is refused (503), so no file is ever called clean unscanned.
    clamd_address: str | None = None
