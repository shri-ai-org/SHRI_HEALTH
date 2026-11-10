"""A stand-in for the Claude API: a real HTTP server on 127.0.0.1 answering ``POST
/v1/messages`` in the Messages API's shape, so the official SDK talks to it unchanged (through
``ANTHROPIC_BASE_URL``). It answers with the text the test sets (``reply``), a refusal
(``refuse``) or an HTTP error (``fail_with``), and keeps every request body and the credential
it got (the SDK sends the key as ``Authorization: Bearer``). It never logs a request.
Synthetic data only."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class StubClaudeServer:
    model = "claude-sonnet-5-5"

    def __init__(self) -> None:
        self.reply = '{"sections": [], "unknowns": []}'
        self.refuse = False
        self.fail_with: int | None = None
        self.usage = {"input_tokens": 1200, "output_tokens": 300}
        self.requests: list[dict[str, Any]] = []
        self.keys: list[str | None] = []
        self._server: ThreadingHTTPServer | None = None

    @property
    def url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host!s}:{port}"

    def start(self) -> None:
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return     # nothing a request carries reaches a log

            def do_POST(self) -> None:  # noqa: N802 (http.server's name)
                if self.path != "/v1/messages":
                    self._send(404, {"type": "error", "error": {"type": "not_found_error",
                                                                 "message": "not found"}})
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                stub.requests.append(body)
                auth = self.headers.get("authorization") or ""
                stub.keys.append(auth.removeprefix("Bearer ") or None)
                if stub.fail_with is not None:
                    self._send(stub.fail_with, {"type": "error", "error": {
                        "type": "api_error", "message": "unavailable"}})
                    return
                refused = stub.refuse
                self._send(200, {
                    "id": "msg_stub", "type": "message", "role": "assistant",
                    "model": body.get("model", stub.model),
                    "content": [] if refused else [{"type": "text", "text": stub.reply}],
                    "stop_reason": "refusal" if refused else "end_turn",
                    "stop_sequence": None,
                    "stop_details": ({"type": "refusal", "category": "general_harms",
                                      "explanation": None} if refused else None),
                    "usage": dict(stub.usage)})

            def _send(self, status: int, payload: dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("request-id", "req_stub")
                self.end_headers()
                self.wfile.write(data)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
