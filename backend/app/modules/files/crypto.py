"""Envelope encryption of an upload before it reaches the clean bucket (D3; Anand's guide Step 6).

``FileCrypto`` is the module's interface: ``seal(data)`` returns the bytes to store and the
file's data key as core wraps it, which goes in ``admin.binary_object.wrapped_data_key``. A
clean upload gets its wrapped key only through ``seal()``; the database keeps it only on a
clean file (``ck_binary_object_key_when_clean``).

TEMPORARY SEAM. Core's ``new_data_key()`` (Thulasi's guide §3: OpenBao Transit data keys) does
not exist yet, and the runtime lock has no encryption library, so nothing here encrypts:
inventing encryption in a module is exactly what D3 forbids. Until core provides it,
``file_crypto()`` gives ``UnconfiguredFileCrypto``, which refuses with ``503
service-unavailable``, so an upload stays ``pending-upload`` (the transaction rolls back) and
can be completed once encryption exists. Tests use the fake in ``tests/fakes.py``.

**What replaces it:** a ``CoreFileCrypto`` whose ``seal()`` calls ``key = await
new_data_key()``, encrypts ``data`` with the plaintext key (AES-256-GCM, with the library core
brings, through a core helper rather than in this module), returns the ciphertext and
``key.wrapped``, and drops the plaintext key. Only ``file_crypto()`` changes to return it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Protocol

from app.core.errors import ServiceUnavailable

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SealedFile:
    data: bytes = field(repr=False)  # what the clean bucket stores
    wrapped_data_key: str = field(repr=False)  # admin.binary_object.wrapped_data_key


class FileCrypto(Protocol):
    async def seal(self, data: bytes) -> SealedFile:
        """Encrypt ``data`` with a new data key; ``ServiceUnavailable`` if it can't."""
        ...


class UnconfiguredFileCrypto:
    """Until core's ``new_data_key()``: every seal is refused (503), never stored in clear."""

    async def seal(self, data: bytes) -> SealedFile:
        log.error("File encryption needed but core's new_data_key() is not available")
        raise ServiceUnavailable("File encryption is not available")


def file_crypto() -> FileCrypto:
    """FastAPI dependency: the file encryption (seam, module docstring)."""
    return UnconfiguredFileCrypto()
