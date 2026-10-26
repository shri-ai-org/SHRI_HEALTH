"""Q31: the build stamp CI puts in the API image, shown to signed-in users only."""

from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings

COMMIT = "7544a31c0d2e4f6a8b9c1d3e5f7a9b0c2d4e6f8a"


def test_local_build_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BUILD_VERSION", raising=False)
    monkeypatch.delenv("BUILD_COMMIT", raising=False)
    settings = Settings()

    assert (settings.build_version, settings.build_commit) == ("dev", "unknown")
    assert settings.build_commit_short == "unknown"


def test_ci_stamp_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUILD_VERSION", "0.1.0")
    monkeypatch.setenv("BUILD_COMMIT", COMMIT)
    settings = Settings()

    assert settings.build_version == "0.1.0"
    assert settings.build_commit_short == COMMIT[:12]


@pytest.mark.parametrize("version", ["0.1.0", "1.2.3-rc.1", "1.2.3+build.5"])
def test_release_versions_accepted(version: str) -> None:
    assert Settings(build_version=version).build_version == version


@pytest.mark.parametrize(
    "version", ["", "latest", "v0.1.0", "0.1", "0.1.0 ", "0.1.0<script>", "1.0.0-" + "x" * 60]
)
def test_malformed_version_stops_startup(version: str) -> None:
    with pytest.raises(ValidationError, match="BUILD_VERSION"):
        Settings(build_version=version)


@pytest.mark.parametrize(
    "commit", ["", "HEAD", "abc123", COMMIT.upper(), COMMIT + "0", "7544a31c0d2e;rm"]
)
def test_malformed_commit_stops_startup(commit: str) -> None:
    with pytest.raises(ValidationError, match="BUILD_COMMIT"):
        Settings(build_commit=commit)


def test_health_never_names_the_build(make_app: Callable[..., FastAPI]) -> None:
    # /health is public through Nginx (T24), so it must not advertise which build is running.
    app = make_app(build_version="0.1.0", build_commit=COMMIT)
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.json() == {"status": "ok"}
    assert "0.1.0" not in response.text and COMMIT[:7] not in response.text
    assert not any("0.1.0" in v or COMMIT[:7] in v for v in response.headers.values())
