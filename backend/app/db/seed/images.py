"""Illustrative images on the demo seed's imaging reports (issue #386; migration 0023).

``images/manifest.json`` lists each image: its file, SHA-256, size and media type, the report it
belongs to (the patient's number and the study's LOINC code), its caption, and its source (URL,
author, date, licence and the licence's text beside it). Only CC0 or public-domain images whose
licence page says so, with no name, date or identifier left in them, labelled "Illustrative
image" and shown only in the demo. Reports with no listed image stay text only.

``manifest()`` reads the list and refuses it, with ``ManifestMismatch``, when a file is missing
or its bytes don't match the SHA-256 or size listed, so a changed image never reaches a chart.
``results.load_results`` stores each image with its report, encrypted through the file service
(``store_generated``, purpose ``imaging``: clean from the start, never scanned), in the report's
transaction. ``seed_files()`` gives it the file store and core's key service the environment
configures, and raises when either is missing: the seed never skips an image or stores one
unencrypted.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from app.core.crypto import FieldCrypto
from app.core.settings import get_settings
from app.modules.files.crypto import AesGcmFileCrypto, CoreDataKeys, FileCrypto
from app.modules.files.storage import (
    FOLDER_ENVIRONMENTS,
    FileStore,
    LocalFileStore,
    configured_store,
)

FOLDER = Path(__file__).with_name("images")
LABEL = "Illustrative image"


class ManifestMismatch(RuntimeError):
    """An image is missing, or isn't the file the manifest pins."""


@dataclass(frozen=True)
class SeedImage:
    file: str
    sha256: str
    size_bytes: int
    content_type: str
    patient: int
    study_loinc: str
    caption: str
    data: bytes


@dataclass(frozen=True)
class SeedFiles:
    """Where the seed stores its images, and how it encrypts them."""
    store: FileStore
    crypto: FileCrypto


def manifest(folder: Path = FOLDER) -> tuple[SeedImage, ...]:
    listed = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))["images"]
    images = []
    for entry in listed:
        path = folder / entry["file"]
        if not path.is_file():
            raise ManifestMismatch(f"{entry['file']}: missing")
        data = path.read_bytes()
        if (hashlib.sha256(data).hexdigest() != entry["sha256"]
                or len(data) != entry["sizeBytes"]):
            raise ManifestMismatch(f"{entry['file']}: not the file the manifest pins")
        if entry["label"] != LABEL or entry["contentType"] not in ("image/jpeg", "image/png"):
            raise ManifestMismatch(f"{entry['file']}: label or media type")
        images.append(SeedImage(entry["file"], entry["sha256"], entry["sizeBytes"],
                                entry["contentType"], entry["patient"], entry["studyLoinc"],
                                entry["caption"], data))
    return tuple(images)


def seed_files() -> tuple[SeedFiles, FieldCrypto]:
    """The file store and core's key service from the environment (the API container's own
    settings during a reset), and the key service's client, for the caller to close; raises
    when either isn't configured."""
    store = configured_store()
    if store is None:
        raise RuntimeError("The seed's images need the file store: set SHRI_S3_* or, in "
                           "development and test, SHRI_FILE_STORE_DIR")
    settings = get_settings()
    if isinstance(store, LocalFileStore) and settings.environment not in FOLDER_ENVIRONMENTS:
        raise RuntimeError("A file folder is for development and test only")
    keys = FieldCrypto(settings)                    # ValueError names what's missing
    app = SimpleNamespace(state=SimpleNamespace(crypto=keys))   # what app.core.crypto reads
    return SeedFiles(store, AesGcmFileCrypto(CoreDataKeys(app))), keys
