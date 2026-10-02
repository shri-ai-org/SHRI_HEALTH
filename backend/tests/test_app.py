"""The socket's guards, without a model: a stub engine stands in. Run: python -m pytest tests -q."""

import os

os.environ['ASR_MAX_SESSIONS'] = '1'

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import app as service  # noqa: E402


class StubEngine:
    def transcribe(self, audio, *, final, context=''):
        return 'stub'

    def describe(self):
        return {'engine': 'stub'}


def client():
    service.ENGINE['engine'] = StubEngine()
    return TestClient(service.app)


def test_one_more_dictation_than_the_cap_is_refused_before_the_handshake():
    c = client()
    with c.websocket_connect('/ws/transcribe') as first:
        assert first.receive_json() == {'type': 'ready'}
        with pytest.raises(WebSocketDisconnect) as refused:
            with c.websocket_connect('/ws/transcribe') as second:
                second.receive_json()
        assert refused.value.code == 4429


def test_the_slot_is_freed_when_a_dictation_ends():
    c = client()
    with c.websocket_connect('/ws/transcribe') as first:
        assert first.receive_json() == {'type': 'ready'}
    with c.websocket_connect('/ws/transcribe') as again:
        assert again.receive_json() == {'type': 'ready'}
