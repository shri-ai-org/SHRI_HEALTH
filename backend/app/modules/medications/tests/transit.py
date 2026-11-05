"""OpenBao Transit for the live tests on a machine without OpenBao (core's tests do the same).

Core encrypts an idempotent request's stored answer through Transit before a retry can replay it
(core/idempotency.py); without OpenBao it can't, so it keeps the claim and a retry gets 409. CI
and any machine with ``OPENBAO_TRANSIT_ADDR`` use the real OpenBao; elsewhere the app gets this
stand-in, which "encrypts" by tagging the text and is never used outside tests.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from pydantic import SecretStr

from app.core.config import Settings
from app.core.crypto import FieldCrypto


def _fake_transit(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if request.url.path.endswith("/encrypt/shri-fields"):
        return httpx.Response(200, json={"data": {"ciphertext": f"vault:v1:{body['plaintext']}"}})
    return httpx.Response(200, json={"data": {
        "plaintext": body["ciphertext"].removeprefix("vault:v1:")}})


def without_openbao(app: Any) -> None:
    """Gives the app the stand-in Transit, only when no OpenBao is configured."""
    if os.environ.get("OPENBAO_TRANSIT_ADDR"):
        return
    app.state.crypto = FieldCrypto(
        Settings(environment="test", openbao_transit_addr="http://bao.test:8200",
                 openbao_transit_token=SecretStr("fake")),
        transport=httpx.MockTransport(_fake_transit))
