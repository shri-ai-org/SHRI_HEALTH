"""The clamd INSTREAM client against a fake clamd (a socket server on localhost and on a Unix
socket, in a thread) that speaks the protocol and checks what the client sends. No ClamAV.
Synthetic data only."""

from __future__ import annotations

import socket
import socketserver
import struct
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from app.core.errors import ServiceUnavailable

from .. import scanner as scanner_module
from ..scanner import CHUNK_BYTES, ClamdScanner, UnconfiguredScanner, parse_address
from .fakes import EICAR

Reply = Callable[[bytes], bytes]


def clamd_reply(data: bytes) -> bytes:
    if EICAR in data:
        return b"stream: Synthetic-Test-Signature FOUND\0"
    return b"stream: OK\0"


class FakeClamd(socketserver.BaseRequestHandler):
    """Reads ``zINSTREAM\\0`` and the length-prefixed chunks up to the zero length, then
    answers ``server.reply(stream)``. Records each stream and its chunk sizes."""

    def handle(self) -> None:
        server = self.server
        sock = self.request
        command = b""
        while not command.endswith(b"\0"):
            command += sock.recv(1)
        assert command == b"zINSTREAM\0"
        stream, sizes = b"", []
        while True:
            (size,) = struct.unpack("!I", _exactly(sock, 4))
            if size == 0:
                break
            sizes.append(size)
            stream += _exactly(sock, size)
        server.streams.append((stream, sizes))  # type: ignore[attr-defined]
        sock.sendall(server.reply(stream))  # type: ignore[attr-defined]


def _exactly(sock: socket.socket, n: int) -> bytes:
    data = b""
    while len(data) < n:
        part = sock.recv(n - len(data))
        assert part, "the client closed the stream early"
        data += part
    return data


def _serve(server: socketserver.BaseServer, reply: Reply) -> Iterator[socketserver.BaseServer]:
    server.streams = []  # type: ignore[attr-defined]
    server.reply = reply  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


@pytest.fixture
def tcp_clamd() -> Iterator[socketserver.BaseServer]:
    yield from _serve(socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeClamd),
                      clamd_reply)


def _address(server: socketserver.BaseServer) -> str:
    address: Any = server.server_address
    return f"{address[0]}:{address[1]}"


async def test_a_clean_stream_in_chunks(tcp_clamd: socketserver.BaseServer) -> None:
    data = b"synthetic clean bytes " * 10_000  # several chunks

    verdict = await ClamdScanner(_address(tcp_clamd)).scan(data)

    assert not verdict.infected and verdict.signature is None
    ((stream, sizes),) = tcp_clamd.streams  # type: ignore[attr-defined]
    assert stream == data
    assert max(sizes) == CHUNK_BYTES and sum(sizes) == len(data)


async def test_an_infected_stream(tcp_clamd: socketserver.BaseServer) -> None:
    verdict = await ClamdScanner(f"tcp://{_address(tcp_clamd)}").scan(b"x" + EICAR)
    assert verdict.infected and verdict.signature == "Synthetic-Test-Signature"


async def test_over_a_unix_socket(tmp_path: Path) -> None:
    path = tmp_path / "clamd.sock"
    for _server in _serve(socketserver.ThreadingUnixStreamServer(str(path), FakeClamd),
                         clamd_reply):
        assert (await ClamdScanner(f"unix://{path}").scan(b"fine")).infected is False


@pytest.mark.parametrize("reply", [
    b"INSTREAM size limit exceeded. ERROR\0",
    b"stream: Can't allocate memory ERROR\0",
    b"",                                   # closed without an answer
    b"stream: something unexpected\0",
    b"stream:  FOUND\0",                   # FOUND without a signature
])
async def test_anything_but_a_verdict_is_unavailable(reply: bytes) -> None:
    for server in _serve(socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeClamd),
                         lambda data: reply):
        with pytest.raises(ServiceUnavailable):
            await ClamdScanner(_address(server)).scan(b"synthetic")


async def test_an_unreachable_clamd_is_unavailable() -> None:
    with socket.socket() as probe:  # a port nothing listens on
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with pytest.raises(ServiceUnavailable):
        await ClamdScanner(f"127.0.0.1:{port}", timeout=2).scan(b"synthetic")


@pytest.mark.parametrize("address", ["", "clamd", "clamd:", "clamd:99999", "unix://relative",
                                     ":3310"])
def test_bad_addresses(address: str) -> None:
    with pytest.raises(ValueError):
        parse_address(address)


async def test_the_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(scanner_module.CLAMD_ADDRESS_ENV, raising=False)
    unconfigured = scanner_module.scanner()
    assert isinstance(unconfigured, UnconfiguredScanner)
    with pytest.raises(ServiceUnavailable):
        await unconfigured.scan(b"x")
    monkeypatch.setenv(scanner_module.CLAMD_ADDRESS_ENV, "clamav:3310")
    configured = scanner_module.scanner()
    assert isinstance(configured, ClamdScanner) and configured.address == ("clamav", 3310)
    monkeypatch.setenv(scanner_module.CLAMD_ADDRESS_ENV, "not an address")
    assert isinstance(scanner_module.scanner(), UnconfiguredScanner)
