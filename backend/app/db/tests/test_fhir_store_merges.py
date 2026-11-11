"""Duplicates and merges by link (D103, D46, D51) against a live database, as shri_app through
the core's tenant session: no record moves, the merged chart refuses writes, and an undo
removes the links. Fixtures are test_fhir_store's."""
from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Engine, text

from app.core.access import ChartAccess, chart_access
from app.core.db import Database
from app.core.deps import CurrentUser
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.models.admin.platform import DuplicateCandidate
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant
from app.db.tests.test_fhir_store import _create, _rows, clinic, database, session

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["clinic", "database"]   # fixtures, used by name

STORE = fs.SqlFhirStore()
WHY = "Same person: matching name, birth date and phone."
HYPERTENSION = fs.Coded(system=systems.ICD10CM, code="I10")


async def _pair(database: Database, clinic: dict[str, Any], a: Any = None, b: Any = None
                ) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """A possible duplicate (two new patients unless given) and its candidate's ID."""
    a = a or (await _create(database, clinic)).id
    b = b or (await _create(database, clinic)).id
    low, high = sorted((a, b))
    async with session(database, clinic) as s:
        pair = DuplicateCandidate(patient_a_id=low, patient_b_id=high,
                                  match_score=Decimal("0.95"))
        s.add(pair)
        await s.commit()
    return a, b, pair.id


async def _merge(database: Database, clinic: dict[str, Any], dup: uuid.UUID,
                 surviving: uuid.UUID) -> fs.MergeWritten:
    async with session(database, clinic) as s:
        done = await STORE.merge_patients(s, dup, surviving, f"  {WHY} ")
        await s.commit()
    return done


async def test_a_merge_links_the_charts_and_moves_nothing(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    keep, gone, dup = await _pair(database, clinic)
    async with session(database, clinic) as s:              # a record on the merged chart
        old = await STORE.create_problem(s, fs.ProblemIn(patient_id=gone, code=HYPERTENSION))
        await s.commit()
    done = await _merge(database, clinic, dup, keep)
    links = _rows(admin_engine, "SELECT patient_id, other_patient_id, type FROM "
                  "clinical.patient_link WHERE :k IN (patient_id, other_patient_id) "
                  "ORDER BY type", k=keep)
    assert [(r.patient_id, r.other_patient_id, r.type) for r in links] == [
        (gone, keep, "replaced-by"), (keep, gone, "replaces")]
    assert _rows(admin_engine, "SELECT active FROM clinical.patient WHERE id = :p",
                 p=gone)[0].active is False
    assert _rows(admin_engine, "SELECT subject_patient_id FROM clinical.condition WHERE id = :c",
                 c=old.id)[0].subject_patient_id == gone            # no record moved
    merge = _rows(admin_engine, "SELECT * FROM admin.patient_merge WHERE id = :m",
                  m=done.merge_id)[0]
    assert (merge.reason, merge.performed_by_user_id, merge.duplicate_candidate_id) == (
        WHY, clinic["user"], dup)
    assert _rows(admin_engine, "SELECT status FROM admin.duplicate_candidate WHERE id = :d",
                 d=dup)[0].status == "merged"
    async with session(database, clinic) as s:
        assert await fs.merged_into(s, gone) == keep and await fs.merged_into(s, keep) is None
        assert set(await fs.chart_patient_ids(s, keep)) == {keep, gone}
        [status] = await fs.patient_merges(s, gone)
        assert (status.id, status.undo_blocked_reason) == (done.merge_id, None)


async def test_a_merged_patient_refuses_writes(database: Database, clinic: dict[str, Any]
                                               ) -> None:
    keep, gone, dup = await _pair(database, clinic)
    await _merge(database, clinic, dup, keep)
    async with session(database, clinic) as s:
        with pytest.raises(fs.PatientMerged) as refused:
            await STORE.create_problem(s, fs.ProblemIn(patient_id=gone, code=HYPERTENSION))
        assert refused.value.surviving_patient_id == keep
        with pytest.raises(fs.PatientMerged):
            await STORE.create_allergy(s, fs.AllergyIn(
                patient_id=gone, code=fs.Coded(text="Peanut")))
        with pytest.raises(fs.PatientMerged):
            await STORE.set_patient_security(s, gone, frozenset())
        await STORE.create_problem(s, fs.ProblemIn(patient_id=keep, code=HYPERTENSION))


@pytest.mark.parametrize(("surviving", "reason", "error", "field"), [
    ("other", WHY, fs.InvalidInput, "survivingPatientId"),
    ("a", "   ", fs.InvalidInput, "reason"),
])
async def test_what_a_merge_refuses(database: Database, clinic: dict[str, Any], surviving: str,
                                    reason: str, error: type[Exception], field: str) -> None:
    a, _, dup = await _pair(database, clinic)
    target = a if surviving == "a" else (await _create(database, clinic)).id
    async with session(database, clinic) as s:
        with pytest.raises(error) as refused:
            await STORE.merge_patients(s, dup, target, reason)
    assert getattr(refused.value, "field", None) == field


async def test_undo_removes_the_links_and_can_be_done_once(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    keep, gone, dup = await _pair(database, clinic)
    done = await _merge(database, clinic, dup, keep)
    async with session(database, clinic) as s:
        undone = await STORE.undo_patient_merge(s, done.merge_id, "Different people.")
        await s.commit()
    assert undone.merged.version > done.merged.version
    assert _rows(admin_engine, "SELECT count(*) AS n FROM clinical.patient_link WHERE "
                 ":k IN (patient_id, other_patient_id)", k=keep)[0].n == 0
    assert _rows(admin_engine, "SELECT active FROM clinical.patient WHERE id = :p",
                 p=gone)[0].active is True
    async with session(database, clinic) as s:
        [status] = await fs.patient_merges(s, keep)
        assert (status.undone_by_user_id, status.undo_blocked_reason) == (
            clinic["user"], "already-undone")
        with pytest.raises(fs.InvalidTransition) as refused:
            await STORE.undo_patient_merge(s, done.merge_id, "Again.")
        assert refused.value.current_state == "already-undone"
        await STORE.create_problem(s, fs.ProblemIn(patient_id=gone, code=HYPERTENSION))


async def test_a_later_merge_blocks_the_undo_and_a_chain_reads_as_one(
        database: Database, clinic: dict[str, Any]) -> None:
    a, b, first = await _pair(database, clinic)
    done = await _merge(database, clinic, first, a)                  # b into a
    _, c, second = await _pair(database, clinic, a=a)
    await _merge(database, clinic, second, c)                        # then a into c
    async with session(database, clinic) as s:
        assert set(await fs.chart_patient_ids(s, c)) == {a, b, c}
        with pytest.raises(fs.InvalidTransition) as refused:
            await STORE.undo_patient_merge(s, done.merge_id, "Different people.")
        assert refused.value.current_state == "later-merge"
    _, _, third = await _pair(database, clinic, a=b)
    async with session(database, clinic) as s:                       # b is merged away
        with pytest.raises(fs.PatientMerged):
            await STORE.merge_patients(s, third, b, WHY)


async def test_dismissing_a_pair_closes_it(database: Database, clinic: dict[str, Any],
                                           admin_engine: Engine) -> None:
    a, _, dup = await _pair(database, clinic)
    async with session(database, clinic) as s:
        await STORE.dismiss_duplicate(s, dup, " Twins. ")
        await s.commit()
    row = _rows(admin_engine, "SELECT * FROM admin.duplicate_candidate WHERE id = :d", d=dup)[0]
    assert (row.status, row.review_note, row.reviewed_by_user_id) == (
        "not-duplicate", "Twins.", clinic["user"])
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.dismiss_duplicate(s, dup, "Twins.")
        with pytest.raises(fs.InvalidTransition):
            await STORE.merge_patients(s, dup, a, WHY)


async def test_another_clinic_sees_none_of_it(database: Database, clinic: dict[str, Any],
                                              admin_engine: Engine) -> None:
    keep, _, dup = await _pair(database, clinic)
    done = await _merge(database, clinic, dup, keep)
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    async with session(database, other) as s:
        with pytest.raises(fs.ResourceNotFound):
            await STORE.undo_patient_merge(s, done.merge_id, "Different people.")
        assert await fs.patient_merges(s, keep) == []


# ------------------------------------------------------------- security labels (#277 review)
def _label(admin_engine: Engine, patient: uuid.UUID, labels: list[str]) -> None:
    with admin_engine.begin() as c:
        c.execute(text("UPDATE clinical.patient SET meta_security = :l WHERE id = :p"),
                  {"l": labels, "p": patient})


def _labels(admin_engine: Engine, patient: uuid.UUID) -> set[str]:
    return set(_rows(admin_engine, "SELECT meta_security FROM clinical.patient WHERE id = :p",
                     p=patient)[0].meta_security)


def _label_provenance(admin_engine: Engine, patient: uuid.UUID) -> int:
    return len(_rows(admin_engine, "SELECT id FROM clinical.provenance WHERE target_id = :p "
                     "AND activity_code = 'UPDATE' AND reason_text LIKE 'Security labels%'",
                     p=patient))


def _as_fhir_reader(admin_engine: Engine, tenant: uuid.UUID, *patients: uuid.UUID
                    ) -> tuple[int, int]:
    """What /fhir's role sees of these patients: their rows, and links pointing at them."""
    with admin_engine.connect() as c:
        c.execute(text("SET LOCAL ROLE shri_fhir_reader"))
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                  {"t": str(tenant)})
        seen = c.execute(text("SELECT count(*) FROM clinical.patient WHERE id = ANY(:ps)"),
                         {"ps": list(patients)}).scalar_one()
        links = c.execute(text("SELECT count(*) FROM clinical.patient_link "
                               "WHERE patient_id = ANY(:ps) OR other_patient_id = ANY(:ps)"),
                          {"ps": list(patients)}).scalar_one()
        c.rollback()
    return seen, links


@pytest.mark.parametrize(("surviving", "merged", "expected"), [
    ([], ["R"], {"R"}),                                  # restricted merged into unrestricted
    (["R"], [], {"R"}),                                  # and the reverse
    (["R"], ["V"], {"V"}),                               # V over R
    (["N", "PSY"], ["R", "SUD"], {"R", "PSY", "SUD"}),   # sensitivity labels are the union
    (["L"], ["M"], {"M"}),
])
async def test_a_merge_gives_both_charts_the_stricter_labels(
        database: Database, clinic: dict[str, Any], admin_engine: Engine,
        surviving: list[str], merged: list[str], expected: set[str]) -> None:
    keep, gone, dup = await _pair(database, clinic)
    _label(admin_engine, keep, surviving)
    _label(admin_engine, gone, merged)
    await _merge(database, clinic, dup, keep)
    assert _labels(admin_engine, keep) == _labels(admin_engine, gone) == expected
    assert _label_provenance(admin_engine, keep) == (set(surviving) != expected)
    assert _label_provenance(admin_engine, gone) == (set(merged) != expected)


async def test_the_same_labels_change_nothing(database: Database, clinic: dict[str, Any],
                                              admin_engine: Engine) -> None:
    keep, gone, dup = await _pair(database, clinic)
    _label(admin_engine, keep, ["R"])
    _label(admin_engine, gone, ["R"])
    await _merge(database, clinic, dup, keep)
    assert _labels(admin_engine, keep) == _labels(admin_engine, gone) == {"R"}
    assert _label_provenance(admin_engine, keep) == _label_provenance(admin_engine, gone) == 0


async def test_reading_the_survivor_of_a_restricted_merge_needs_break_glass(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    keep, gone, dup = await _pair(database, clinic)
    _label(admin_engine, gone, ["R"])
    user = CurrentUser(id=clinic["user"], organization_id=clinic["tenant"],
                       roles=frozenset({"FD"}), facility_ids=frozenset(),
                       display_name="Test user")
    async with session(database, clinic) as s:
        assert await chart_access(s, user, keep) == ChartAccess.OPEN
    await _merge(database, clinic, dup, keep)
    async with session(database, clinic) as s:
        assert await chart_access(s, user, keep) == ChartAccess.BLOCKED
        assert await chart_access(s, user, gone) == ChartAccess.BLOCKED


@pytest.mark.parametrize("restricted", ["merged", "surviving"])
async def test_fhir_shows_neither_chart_of_a_restricted_merge(
        database: Database, clinic: dict[str, Any], admin_engine: Engine,
        restricted: str) -> None:
    keep, gone, dup = await _pair(database, clinic)
    _label(admin_engine, gone if restricted == "merged" else keep, ["V"])
    await _merge(database, clinic, dup, keep)
    assert _as_fhir_reader(admin_engine, clinic["tenant"], keep, gone) == (0, 0)


async def test_an_unrestricted_merge_stays_visible_on_fhir(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    keep, gone, dup = await _pair(database, clinic)
    await _merge(database, clinic, dup, keep)
    assert _as_fhir_reader(admin_engine, clinic["tenant"], keep, gone) == (2, 2)


async def test_a_second_merge_is_refused_and_changes_nothing(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    keep, gone, dup = await _pair(database, clinic)
    _label(admin_engine, gone, ["R"])
    await _merge(database, clinic, dup, keep)
    before = _rows(admin_engine, "SELECT id, meta_version_id, meta_security FROM "
                   "clinical.patient WHERE id IN (:a, :b) ORDER BY id", a=keep, b=gone)
    with pytest.raises(fs.InvalidTransition):
        await _merge(database, clinic, dup, keep)
    after = _rows(admin_engine, "SELECT id, meta_version_id, meta_security FROM "
                  "clinical.patient WHERE id IN (:a, :b) ORDER BY id", a=keep, b=gone)
    assert after == before
    assert _label_provenance(admin_engine, keep) == 1


async def test_an_undo_keeps_the_stricter_labels(database: Database, clinic: dict[str, Any],
                                                 admin_engine: Engine) -> None:
    keep, gone, dup = await _pair(database, clinic)
    _label(admin_engine, gone, ["R"])
    done = await _merge(database, clinic, dup, keep)
    async with session(database, clinic) as s:
        await STORE.undo_patient_merge(s, done.merge_id, "Not the same person.")
        await s.commit()
    assert _labels(admin_engine, keep) == _labels(admin_engine, gone) == {"R"}
    assert _as_fhir_reader(admin_engine, clinic["tenant"], keep, gone) == (0, 0)
