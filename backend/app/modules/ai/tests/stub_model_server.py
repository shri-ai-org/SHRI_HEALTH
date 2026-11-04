"""A stand-in for the model server: a real HTTP server on 127.0.0.1 serving the OpenAI-compatible
chat API (``POST /v1/chat/completions``), as vLLM does. It answers with the reply the test sets
(``reply``), or with an HTTP error (``fail_with``), and keeps every request body it was sent so
the test can check what the gateway sent. It never logs a request. Synthetic data only."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class StubModelServer:
    model = "stub/qwen3.5-4b"

    def __init__(self) -> None:
        self.reply: str | Callable[[dict[str, Any]], str] = '{"sections": []}'
        self.fail_with: int | None = None
        self.requests: list[dict[str, Any]] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host!s}:{port}/v1"

    def start(self) -> None:
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return     # nothing a request carries reaches a log

            def do_POST(self) -> None:  # noqa: N802 (http.server's name)
                if self.path != "/v1/chat/completions":
                    self._send(404, {"error": {"message": "not found"}})
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                stub.requests.append(body)
                if stub.fail_with is not None:
                    self._send(stub.fail_with, {"error": {"message": "unavailable"}})
                    return
                content = stub.reply(body) if callable(stub.reply) else stub.reply
                self._send(200, {
                    "id": "chatcmpl-stub", "object": "chat.completion", "model": stub.model,
                    "choices": [{"index": 0, "finish_reason": "stop",
                                 "message": {"role": "assistant", "content": content}}],
                    "usage": {"prompt_tokens": 900, "completion_tokens": 300,
                              "total_tokens": 1200}})

            def _send(self, status: int, payload: dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
