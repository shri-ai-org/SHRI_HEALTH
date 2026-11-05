"""The preferred-pharmacy helpers (D50: ``set_preferred_pharmacy``, ``preferred_pharmacy``)
against a live database, as shri_app through the core's tenant session. Fixtures are
test_fhir_store's. Pharmacies are the platform directory: every clinic chooses from the same
rows, and only the choice belongs to the clinic."""
from __future__ import annotations

import secrets
import uuid
from typing import Any

import pytest
from sqlalchemy import Engine, text

from app.core.db import Database
from app.db import fhir_store as fs
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant
from app.db.tests.test_fhir_store import _create, _rows, clinic, database, session

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["clinic", "database"]   # fixtures, used by name

STORE = fs.SqlFhirStore()


def _pharmacy(admin_engine: Engine, name: str, *, active: bool = True) -> uuid.UUID:
    """A pharmacy in the platform directory (synthetic)."""
    pharmacy = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.pharmacy (id, ncpdp_id, name, phone, address_line, "
                       "city, state, postal_code, is_mail_order, is_active) VALUES (:i, :n, "
                       ":name, '+12175550190', '90 Sample Avenue', 'Springfield', 'IL', "
                       "'62704', false, :a)"),
                  {"i": pharmacy, "n": f"{secrets.randbelow(10**7):07d}", "name": name,
                   "a": active})
    return pharmacy


async def _set(database: Database, clinic: dict[str, Any], patient: uuid.UUID,
               pharmacy: uuid.UUID, version: int) -> fs.Written:
    async with session(database, clinic) as s:
        w = await STORE.set_preferred_pharmacy(s, patient, pharmacy, if_version=version)
        await s.commit()
    return w


async def _read(database: Database, clinic: dict[str, Any], patient: uuid.UUID
                ) -> fs.PreferredPharmacy | None:
    async with session(database, clinic) as s:
        return await fs.preferred_pharmacy(s, patient)


async def test_setting_it_moves_the_patients_version_and_reads_back(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    pt = await _create(database, clinic)
    assert await _read(database, clinic, pt.id) is None
    first = _pharmacy(admin_engine, "First Pharmacy (synthetic)")
    w = await _set(database, clinic, pt.id, first, pt.version)
    assert (w.id, w.version) == (pt.id, pt.version + 1) and w.last_updated > pt.last_updated
    got = await _read(database, clinic, pt.id)
    assert got is not None and (got.pharmacy_id, got.name, got.city, got.state, got.postal_code
                                ) == (first, "First Pharmacy (synthetic)", "Springfield", "IL",
                                      "62704")
    history = _rows(admin_engine, "SELECT version_id FROM clinical.fhir_resource_history "
                    "WHERE resource_id = :p ORDER BY version_id", p=pt.id)
    assert [r.version_id for r in history] == [pt.version, w.version]
    row = _rows(admin_engine, "SELECT tenant_id, created_by_user_id FROM admin.patient_pharmacy "
                "WHERE patient_id = :p", p=pt.id)
    assert [tuple(r) for r in row] == [(clinic["tenant"], clinic["user"])]


async def test_a_new_choice_replaces_the_default_and_keeps_the_old_one(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    pt = await _create(database, clinic)
    first = _pharmacy(admin_engine, "First Pharmacy (synthetic)")
    second = _pharmacy(admin_engine, "Second Pharmacy (synthetic)")
    w1 = await _set(database, clinic, pt.id, first, pt.version)
    w2 = await _set(database, clinic, pt.id, second, w1.version)
    w3 = await _set(database, clinic, pt.id, first, w2.version)     # back to an earlier one
    assert w3.version == w2.version + 1 == w1.version + 2
    rows = _rows(admin_engine, "SELECT pharmacy_id, is_default FROM admin.patient_pharmacy "
                 "WHERE patient_id = :p", p=pt.id)
    assert {(r.pharmacy_id, r.is_default) for r in rows} == {(first, True), (second, False)}
    got = await _read(database, clinic, pt.id)
    assert got is not None and got.pharmacy_id == first


async def test_the_same_pharmacy_again_changes_nothing(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    pt = await _create(database, clinic)
    pharmacy = _pharmacy(admin_engine, "Same Pharmacy (synthetic)")
    w1 = await _set(database, clinic, pt.id, pharmacy, pt.version)
    w2 = await _set(database, clinic, pt.id, pharmacy, w1.version)
    assert w2 == w1
    assert len(_rows(admin_engine, "SELECT 1 FROM admin.patient_pharmacy WHERE patient_id = :p",
                     p=pt.id)) == 1


async def test_what_is_refused(database: Database, clinic: dict[str, Any],
                               admin_engine: Engine) -> None:
    pt = await _create(database, clinic)
    active = _pharmacy(admin_engine, "Open Pharmacy (synthetic)")
    closed = _pharmacy(admin_engine, "Closed Pharmacy (synthetic)", active=False)
    async with session(database, clinic) as s:
        with pytest.raises(fs.StaleVersion):
            await STORE.set_preferred_pharmacy(s, pt.id, active, if_version=pt.version + 1)
    async with session(database, clinic) as s:
        with pytest.raises(fs.ResourceNotFound):         # not in the directory
            await STORE.set_preferred_pharmacy(s, pt.id, uuid.uuid4(), if_version=pt.version)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput):             # no longer accepts prescriptions
            await STORE.set_preferred_pharmacy(s, pt.id, closed, if_version=pt.version)
    assert await _read(database, clinic, pt.id) is None


async def test_another_clinic_can_neither_set_nor_read_it(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    pt = await _create(database, clinic)
    pharmacy = _pharmacy(admin_engine, "Clinic A's choice (synthetic)")
    await _set(database, clinic, pt.id, pharmacy, pt.version)
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    async with session(database, other) as s:
        with pytest.raises(fs.ResourceNotFound):
            await STORE.set_preferred_pharmacy(s, pt.id, pharmacy, if_version=pt.version + 1)
    async with session(database, other) as s:
        with pytest.raises(fs.ResourceNotFound):
            await fs.preferred_pharmacy(s, pt.id)
        rows = (await s.execute(text("SELECT count(*) FROM admin.patient_pharmacy "
                                     "WHERE patient_id = :p"), {"p": pt.id})).scalar_one()
        assert rows == 0                                  # RLS: the choice is clinic A's
