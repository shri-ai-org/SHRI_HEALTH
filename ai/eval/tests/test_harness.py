"""The harness end to end against a local stub of an OpenAI-compatible endpoint (a tiny
http.server in this process) that returns canned drafts: perfect, with omissions, or with
invented facts. The scores must rank them, and no transcript text may reach the console or
the summary."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from shri_eval.cli import main, run
from shri_eval.client import ChatClient, EndpointError, messages, redact_url
from shri_eval.dataset import load_visits

from .drafts import reply

VISITS = {v.data["transcript"][0]["text"]: v for v in load_visits()}


class Stub:
    def __init__(self) -> None:
        self.mode = "perfect"
        self.status = 200
        self.requests: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []


def _handler(stub: Stub) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 (http.server's name)
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            stub.requests.append(body)
            stub.headers.append(dict(self.headers))
            if self.path != "/v1/chat/completions" or stub.status != 200:
                self.send_response(stub.status if stub.status != 200 else 404)
                self.end_headers()
                self.wfile.write(b'{"error": "secret transcript echo"}')
                return
            user = body["messages"][1]["content"]
            visit = next(v for first, v in VISITS.items() if first in user)
            out = {"choices": [{"message": {"role": "assistant",
                                            "content": reply(visit, stub.mode)}}],
                   "usage": {"prompt_tokens": 900, "completion_tokens": 300}}
            data = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args: Any) -> None:   # keep the test output clean
            pass

    return Handler


@pytest.fixture(scope="module")
def stub() -> Iterator[tuple[Stub, str]]:
    state = Stub()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield state, f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def _run(stub: tuple[Stub, str], mode: str, out: Path) -> dict[str, Any]:
    state, url = stub
    state.mode, state.status = mode, 200
    return run(ChatClient(endpoint=url, model="stub-model"), out / mode, echo=False)


def test_the_scores_rank_the_three_drafts(stub: tuple[Stub, str], tmp_path: Path) -> None:
    perfect = _run(stub, "perfect", tmp_path)
    omissions = _run(stub, "omissions", tmp_path)
    inventions = _run(stub, "inventions", tmp_path)
    p, o, i = perfect["summary"], omissions["summary"], inventions["summary"]
    assert p["overall"] == 1.0
    assert p["overall"] > o["overall"] and p["overall"] > i["overall"]
    assert o["sectionCoverage"] < p["sectionCoverage"] and o["factRecall"] < p["factRecall"]
    assert i["invention"] < p["invention"] and i["invention"] < o["invention"]
    for rows in zip(perfect["visits"], omissions["visits"], inventions["visits"], strict=True):
        best, omitted, invented = (r["scores"]["overall"] for r in rows)
        assert best > omitted and best > invented, rows[0]["id"]
    assert perfect["failed"] == [] and len(perfect["visits"]) == 10


def test_the_report_files_and_what_they_hold(stub: tuple[Stub, str], tmp_path: Path) -> None:
    report = _run(stub, "inventions", tmp_path)
    saved = json.loads((tmp_path / "inventions" / "report.json").read_text())
    assert saved == report
    assert saved["model"] == "stub-model" and saved["harness"]["promptVersion"]
    first = saved["visits"][0]
    assert first["promptTokens"] == 900 and first["completionTokens"] == 300
    assert first["scores"]["findings"]["mustNotInventHits"]
    summary = (tmp_path / "inventions" / "summary.md").read_text()
    assert "| visit-01 | neurology |" in summary and "**Mean**" in summary
    for visit in load_visits():
        for turn in visit.data["transcript"]:
            assert turn["text"] not in summary


def test_the_console_shows_numbers_only(stub: tuple[Stub, str], tmp_path: Path,
                                        capsys: pytest.CaptureFixture[str],
                                        monkeypatch: pytest.MonkeyPatch) -> None:
    state, url = stub
    state.mode, state.status = "perfect", 200
    monkeypatch.setenv("STUB_KEY", "test-key-not-secret")
    code = main(["--endpoint", url, "--model", "stub-model", "--out", str(tmp_path / "cli"),
                 "--api-key-env", "STUB_KEY", "--visit", "visit-01", "--visit", "visit-09",
                 "--json-mode", "--no-thinking"])
    out = capsys.readouterr().out
    assert code == 0 and "visit-01: overall 1.000" in out and "visit-09" in out
    for visit in load_visits(["visit-01", "visit-09"]):
        for turn in visit.data["transcript"]:
            assert turn["text"] not in out
    assert state.headers[-1]["Authorization"] == "Bearer test-key-not-secret"
    sent = state.requests[-1]
    assert sent["response_format"] == {"type": "json_object"}
    assert sent["chat_template_kwargs"] == {"enable_thinking": False}
    assert sent["temperature"] == 0.0 and sent["model"] == "stub-model"


def test_a_failing_endpoint_never_shows_its_body(stub: tuple[Stub, str], tmp_path: Path,
                                                 capsys: pytest.CaptureFixture[str]) -> None:
    state, url = stub
    state.status = 500
    with pytest.raises(EndpointError) as caught:
        ChatClient(endpoint=url, model="m").complete(messages(load_visits(["visit-01"])[0]))
    assert str(caught.value) == "HTTP 500" and "secret" not in str(caught.value)
    code = main(["--endpoint", url, "--model", "m", "--out", str(tmp_path / "f"),
                 "--visit", "visit-01"])
    assert code == 1 and "secret" not in capsys.readouterr().out
    report = json.loads((tmp_path / "f" / "report.json").read_text())
    assert report["failed"] == ["visit-01"] and report["summary"]["overall"] is None
    state.status = 200


def test_a_missing_api_key_variable_stops_the_run(tmp_path: Path,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NOT_SET_KEY", raising=False)
    assert main(["--endpoint", "http://127.0.0.1:9/v1", "--model", "m", "--out",
                 str(tmp_path), "--api-key-env", "NOT_SET_KEY"]) == 2


def test_the_prompt_lists_the_templates_sections() -> None:
    visit = load_visits(["visit-02"])[0]
    system, user = messages(visit)
    assert "- 69730-0: Patient instructions" in system["content"]
    assert "- 29545-1: Physical exam (required)" in system["content"]
    assert user["content"].startswith("Patient: 52-year-old female.\nTranscript:\nClinician: ")


def test_report_urls_lose_credentials_and_queries() -> None:
    assert redact_url("http://user:pw@gpu-host:8000/v1?token=x#y") == "http://gpu-host:8000/v1"
