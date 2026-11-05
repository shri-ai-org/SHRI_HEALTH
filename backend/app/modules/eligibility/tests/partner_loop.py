"""The whole partner loop for the live tests, on a branch with Thulasi's #186: the outbox worker
(as ``shri_integration``) sends a queued message through the simulated payer or pharmacy, whose
signed reply comes back to ``/hooks/<partner>`` on an API app (as ``shri_app``) and is filed by
the module's bridge. The replies the simulated partner posted are kept, so a test can post them
again. Importing this module skips the test module where #186 isn't present.

The builders and hooks run as ``shri_integration``, so the loop needs that role's grants on the
module tables (D23, Anand); ``require_worker_grants`` skips a test until they exist.
"""

from __future__ import annotations

import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.db import Database
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role, sync_url

simulated: Any = pytest.importorskip("app.integration.simulated",
                                     reason="needs core's partner callbacks (#186)")
partner_hooks: Any = pytest.importorskip("app.core.partner_hooks",
                                         reason="needs core's partner callbacks (#186)")
worker: Any = pytest.importorskip("app.integration.worker")

BASE_URL = "http://api.test"
FINAL = ("sent", "dead-letter")


@dataclass(frozen=True)
class Posted:
    """A reply the simulated partner posted: its body and signed headers."""

    body: bytes
    headers: dict[str, str]


def settings() -> Settings:
    """The API's settings for the loop: hook secrets and the simulated partners (test only)."""
    extra: dict[str, Any] = {
        "hook_secret_clearinghouse": SecretStr(secrets.token_hex(32)),
        "hook_secret_erx": SecretStr(secrets.token_hex(32)),
        "simulated_partners": True, "simulated_partner_callback_url": BASE_URL}
    return Settings(environment="test", auth_mode="dev_header", database_url=TEST_DATABASE_URL,
                    **extra)


async def hook_app() -> AsyncIterator[FastAPI]:
    """The API app that receives the callbacks, as shri_app (use as an async fixture)."""
    from app.main import create_app

    app = create_app(settings())
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    try:
        yield app
    finally:
        await app.state.db.dispose()


def require_worker_grants(*tables: str) -> None:
    """Skips the test until shri_integration may read the tables its builders read."""
    engine = create_engine(sync_url(), poolclass=NullPool)
    try:
        with engine.connect() as c:
            missing = [t for t in tables if not c.execute(text(
                "SELECT has_table_privilege('shri_integration', :t, 'SELECT')"), {"t": t}
            ).scalar_one()]
    finally:
        engine.dispose()
    if missing:
        pytest.skip(f"shri_integration can't read {', '.join(missing)} yet (D23, Anand)")


def endpoint(tenant: UUID, kind: str, adapter: str) -> UUID:
    """The clinic's connection to the simulated partner (its adapter key)."""
    endpoint_id = uuid4()
    engine = create_engine(sync_url(), poolclass=NullPool)
    try:
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, name, "
                "environment, baa_on_file, is_active) VALUES (:i, :t, :k, :a, 'Simulated', "
                "'test', false, true)"), {"i": endpoint_id, "t": tenant, "k": kind, "a": adapter})
    finally:
        engine.dispose()
    return endpoint_id


def outbound(message_id: UUID) -> Any:
    engine = create_engine(sync_url(), poolclass=NullPool)
    try:
        with engine.connect() as c:
            return c.execute(text(
                "SELECT status, last_error, control_id, attempts FROM admin.integration_message "
                "WHERE id = :i"), {"i": message_id}).one()
    finally:
        engine.dispose()


def inbound(tenant: UUID) -> list[tuple[str, str | None]]:
    """The clinic's inbound messages, oldest first: (status, last_error)."""
    engine = create_engine(sync_url(), poolclass=NullPool)
    try:
        with engine.connect() as c:
            return [(r.status, r.last_error) for r in c.execute(text(
                "SELECT status, last_error FROM admin.integration_message WHERE tenant_id = :t "
                "AND direction = 'inbound' ORDER BY created_at, id"), {"t": tenant})]
    finally:
        engine.dispose()


def partner_audit(tenant: UUID) -> list[tuple[str, UUID | None, str | None]]:
    """The partner's audit rows in the clinic: (outcome, patient, reason)."""
    engine = create_engine(sync_url(), poolclass=NullPool)
    try:
        with engine.connect() as c:
            return [(r.outcome, r.patient_id, r.reason) for r in c.execute(text(
                "SELECT outcome, patient_id, reason FROM audit.audit_event WHERE tenant_id = :t "
                "AND actor_type = 'partner' ORDER BY id"), {"t": tenant})]
    finally:
        engine.dispose()


async def deliver(app: FastAPI, partner: str, adapter: str, message_id: UUID, *,
                  delay: float = 0.0, rounds: int = 10) -> list[Posted]:
    """Runs the worker until the message is sent or dead-lettered (other tests' rows may be
    claimed too), then waits for the simulated partner's replies; returns what it posted."""
    posted: list[Posted] = []

    async def keep(request: httpx.Request) -> None:
        posted.append(Posted(request.content, dict(request.headers)))

    to_api = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE_URL,
                               event_hooks={"request": [keep]})
    worker_db = Database(Settings(environment="test", database_url=TEST_DATABASE_URL))
    switch_to_role(worker_db.engine.sync_engine, "shri_integration")
    simulated_partner = simulated.SimulatedPartner(app.state.settings, partner, client=to_api,
                                                   delay=delay)
    try:
        for _ in range(rounds):
            await worker.OutboxWorker(worker_db, {adapter: simulated_partner},
                                      batch=500).run_once()
            if outbound(message_id).status in FINAL:
                break
        await simulated_partner.drain()
    finally:
        await simulated_partner.aclose()
        await worker_db.dispose()
    return posted


async def post(app: FastAPI, partner: str, tenant: UUID, body: bytes,
               message_id: str | None = None, headers: dict[str, str] | None = None) -> int:
    """Posts a callback: with ``headers`` exactly as given (a replay), otherwise signed afresh
    under ``message_id`` (the partner sending it again)."""
    signed = headers if headers is not None else partner_hooks.sign(
        app.state.settings, partner, message_id, tenant, body)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url=BASE_URL) as c:
        response = await c.post(f"/hooks/{partner}", content=body, headers=signed)
    status: int = response.status_code
    return status

