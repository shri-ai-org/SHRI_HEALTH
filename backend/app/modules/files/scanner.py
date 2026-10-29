"""The malware scan an upload must pass before it is clean (API_STANDARDS §15 step 3).

``Scanner`` is the module's interface; ``ClamdScanner`` speaks clamd's ``INSTREAM`` protocol
with the standard library's ``socket`` (no antivirus library is in the lock):

    client: zINSTREAM\\0
            <4-byte big-endian length><chunk> ...  (each chunk at most CHUNK_BYTES)
            \\0\\0\\0\\0                              (end of stream)
    clamd:  "stream: OK\\0"  |  "stream: <signature> FOUND\\0"  |  "<reason> ERROR\\0"

Anything but OK or FOUND (an ERROR such as the stream size limit, no answer, a closed or refused
connection, a timeout) is ``503 service-unavailable``: a file is never called clean unless clamd
said so.

TEMPORARY SEAM. ClamAV is not in compose yet (asked of Thulasi on #13), so clamd's address comes
from the environment variable ``CLAMD_ADDRESS`` (``host:port``, ``tcp://host:port`` or
``unix:///path/to/clamd.sock``); without it, ``scanner()`` gives ``UnconfiguredScanner``, which
refuses every scan with 503. When ClamAV runs in compose and core has a setting for it, only
``scanner()`` changes. Tests use the fake in ``tests/fakes.py``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import struct
from dataclasses import dataclass
from typing import Protocol

from app.core.errors import ServiceUnavailable

log = logging.getLogger(__name__)

CLAMD_ADDRESS_ENV = "CLAMD_ADDRESS"
CHUNK_BYTES = 64 * 1024
TIMEOUT_SECONDS = 60.0
MAX_REPLY_BYTES = 4096


@dataclass(frozen=True)
class ScanResult:
    infected: bool
    signature: str | None = None  # the malware's name when infected; never patient data


class Scanner(Protocol):
    async def scan(self, data: bytes) -> ScanResult:
        """Scan ``data``; ``ServiceUnavailable`` when the scanner can't give a verdict."""
        ...


class UnconfiguredScanner:
    """What ``scanner()`` gives without ``CLAMD_ADDRESS``: every scan is refused (503)."""

    async def scan(self, data: bytes) -> ScanResult:
        log.error("Malware scan needed but %s is not set", CLAMD_ADDRESS_ENV)
        raise ServiceUnavailable("The malware scanner is not configured")


def parse_address(address: str) -> str | tuple[str, int]:
    """A Unix socket path, or ``(host, port)``; ``ValueError`` for anything else."""
    if address.startswith("unix://"):
        path = address.removeprefix("unix://")
        if not path.startswith("/"):
            raise ValueError("A clamd socket path must be absolute")
        return path
    host, sep, port = address.removeprefix("tcp://").rpartition(":")
    if not sep or not host or not port.isdigit() or not 0 < int(port) < 65536:
        raise ValueError("A clamd address is host:port, tcp://host:port or unix:///path")
    return host.strip("[]"), int(port)


class ClamdScanner:
    """clamd's INSTREAM over TCP or a Unix socket; one connection per scan."""

    def __init__(self, address: str, *, timeout: float = TIMEOUT_SECONDS) -> None:
        self.address = parse_address(address)
        self.timeout = timeout

    async def scan(self, data: bytes) -> ScanResult:
        try:
            reply = await asyncio.to_thread(self._instream, data)
        except OSError as error:
            log.error("clamd unreachable (%s)", type(error).__name__)
            raise ServiceUnavailable("The malware scanner is unavailable") from None
        return self.verdict(reply)

    def _instream(self, data: bytes) -> bytes:
        if isinstance(self.address, str):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(self.timeout)
            sock.connect(self.address)
        else:
            sock = socket.create_connection(self.address, timeout=self.timeout)
        with sock:
            sock.sendall(b"zINSTREAM\0")
            for start in range(0, len(data), CHUNK_BYTES):
                chunk = data[start:start + CHUNK_BYTES]
                sock.sendall(struct.pack("!I", len(chunk)) + chunk)
            sock.sendall(struct.pack("!I", 0))
            reply = b""
            while b"\0" not in reply and len(reply) < MAX_REPLY_BYTES:
                part = sock.recv(MAX_REPLY_BYTES)
                if not part:
                    break
                reply += part
        return reply

    @staticmethod
    def verdict(reply: bytes) -> ScanResult:
        """clamd's answer to a scan; ``ServiceUnavailable`` for anything but OK or FOUND."""
        text = reply.split(b"\0", 1)[0].decode("utf-8", "replace").strip()
        _, _, result = text.partition(": ")
        if result == "OK":
            return ScanResult(infected=False)
        if result.endswith(" FOUND") and result.removesuffix(" FOUND").strip():
            return ScanResult(infected=True, signature=result.removesuffix(" FOUND").strip())
        log.error("clamd gave no verdict (%s)", "error" if text.endswith("ERROR") else "no reply")
        raise ServiceUnavailable("The malware scanner is unavailable")


def scanner() -> Scanner:
    """FastAPI dependency: the scanner (seam: ``CLAMD_ADDRESS``, module docstring)."""
    address = os.environ.get(CLAMD_ADDRESS_ENV)
    if not address:
        return UnconfiguredScanner()
    try:
        return ClamdScanner(address)
    except ValueError:
        log.error("%s is not a valid clamd address", CLAMD_ADDRESS_ENV)
        return UnconfiguredScanner()
