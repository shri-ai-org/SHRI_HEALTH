"""The short-lived token in a decrypting download link (Anand's decision; contract asked on #128).

An encrypted file can't be served by a pre-signed store link: the store holds ciphertext. So
``createDownloadUrl`` gives an encrypted file a link to the file service's own endpoint,
proposed as ``GET /files/{fileId}/content?token=…`` (service.serve_content), which decrypts as it
streams. The token names the file, the user and the clinic and expires with the link; the
endpoint still needs the session and makes every permission and restricted-chart check again,
so a leaked token alone opens nothing.

``DownloadTokens`` is the module's interface. TEMPORARY SEAM: signing is core's (D3), and core
has no ``sign_download_token`` yet (asked of Thulasi), so ``download_tokens()`` gives
``UnconfiguredDownloadTokens``, which refuses with ``503 service-unavailable``: an encrypted
file has no download link until then. Nothing here invents a signature. Tests use the fake in
``tests/fakes.py``.

**What replaces it:** a ``CoreDownloadTokens`` whose ``sign`` and ``verify`` call core's
``sign_download_token`` and its verification; only ``download_tokens()`` changes. The route
itself is mounted once the contract has the operation (core refuses routes that aren't in the
operations map).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from app.core.errors import ServiceUnavailable

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class DownloadClaims:
    file_id: UUID
    user_id: UUID
    tenant_id: UUID
    expires_at: datetime


class DownloadTokens(Protocol):
    def sign(self, claims: DownloadClaims) -> str:
        """An opaque, URL-safe token for ``claims``. A bearer secret: never log it."""
        ...

    def verify(self, token: str) -> DownloadClaims | None:
        """The claims of a genuine, unexpired token, else None."""
        ...


class UnconfiguredDownloadTokens:
    """Until core's ``sign_download_token``: no token is made or accepted (503)."""

    def sign(self, claims: DownloadClaims) -> str:
        log.error("A download token is needed but core's sign_download_token is not available")
        raise ServiceUnavailable("Encrypted downloads are not available yet")

    def verify(self, token: str) -> DownloadClaims | None:
        raise ServiceUnavailable("Encrypted downloads are not available yet")


def download_tokens() -> DownloadTokens:
    """FastAPI dependency: download-link tokens (seam, module docstring)."""
    return UnconfiguredDownloadTokens()
