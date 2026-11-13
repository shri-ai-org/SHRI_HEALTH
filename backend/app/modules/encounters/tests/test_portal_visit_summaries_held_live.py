"""The portal's visit-summary held read (``SqlPortalSummaryReads.held``) still runs on
``admin.portal_held_items()`` (0011), while the problems read moved to
``admin.portal_held_records()`` (0022). This pins it, so a later change to the old function
can't break the visit-summary "held by your clinician" marker unseen: as ``shri_portal`` with
the session's patient set, the held summary comes back with its ID and date, the available one
doesn't, and another patient gets nothing. Live database, synthetic data only."""

from __future__ import annotations

import asyncio
from uuid import UUID

import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.db import Database
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role
from app.modules.encounters.portal_repository import HeldRow, SqlPortalSummaryReads
from app.modules.scheduling.tests.portal_live import PortalChart
from app.modules.scheduling.tests.portal_live import portal_chart as portal_chart  # noqa: F401

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]


async def _held(chart: PortalChart, patient: UUID) -> list[HeldRow]:
    database = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(database.engine.sync_engine, "shri_portal")
    try:
        async with database.patient_session(chart.practice.clinic, patient) as db:
            return await SqlPortalSummaryReads().held(db)
    finally:
        await database.dispose()


def test_the_visit_summary_held_read_still_lists_a_held_summary(
        portal_chart: PortalChart) -> None:
    held = asyncio.run(_held(portal_chart, portal_chart.a))
    ids = [row.id for row in held]
    assert ids == [portal_chart.ids["a-held-avs"]]               # the held one, nothing else
    assert all(row.date is not None for row in held)
    assert portal_chart.ids["a-avs"] not in ids                   # an available one isn't held
    assert asyncio.run(_held(portal_chart, portal_chart.b)) == []  # never another patient's
