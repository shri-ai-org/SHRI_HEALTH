"""Migration 0026: admin.portal_prescription_transmissions(), where the session patient's
prescriptions went (D93, D97), as shri_portal: the pharmacy's name and the latest outbound
NewRx's status, for the patient's own signed prescriptions only; never a draft, an
entered-in-error or a reported medication, another patient's or another clinic's; never an
address, error text or clinician; EXECUTE for shri_portal only, and still no privilege on
admin.pharmacy or admin.erx_transaction. Synthetic data only."""
from __future__ import annotations

import datetime as dt
import secrets
import uuid
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.test_portal_access import _as_patient, chart, portal_engine

__all__ = ["chart", "portal_engine"]       # fixtures, used by name
M = MAPPERS
READ = "SELECT * FROM admin.portal_prescription_transmissions()"


def _pharmacy(admin_engine: Engine, name: str) -> uuid.UUID:
    """A pharmacy in the platform directory, with the address and phone the portal never gets."""
    pharmacy = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.pharmacy (id, ncpdp_id, name, phone, address_line, "
                       "city, state, postal_code, is_mail_order, is_active) VALUES (:i, :n, :name, "
                       "'555-0100', '1 Test Way', 'San Jose', 'CA', '95110', false, true)"),
                  {"i": pharmacy, "n": f"{secrets.randbelow(10**7):07d}", "name": name})
    return pharmacy


def _signed(s: Session, chart: dict[str, Any], who: str = "me") -> Any:
    mr = b.prescription(s, chart[who]["pt"], chart[who]["enc"], chart["ctx"])
    b.sign_prescription(s, mr, chart["ctx"])
    return mr


def _sent(s: Session, mr: Any, pharmacy: uuid.UUID, status: str, minutes: int,
          **kw: Any) -> None:
    s.add(M["erx_transaction"](medication_request_id=mr.id, patient_id=mr.subject_patient_id,
                               pharmacy_id=pharmacy, message_type="NewRx", direction="outbound",
                               status=status, occurred_at=b.NOW + dt.timedelta(minutes=minutes),
                               **kw))
    s.flush()


def _read(c: Connection, chart: dict[str, Any], who: str = "me") -> dict[uuid.UUID, Any]:
    _as_patient(c, chart, who)
    return {r.medication_request_id: r for r in c.execute(text(READ))}


@pytest.mark.db
def test_own_signed_prescriptions_give_the_pharmacy_name_and_the_latest_status(
        portal_engine: Engine, admin_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    first, second = _pharmacy(admin_engine, "Test Pharmacy One"), _pharmacy(admin_engine,
                                                                            "Test Pharmacy Two")
    sent = _signed(s, chart)
    _sent(s, sent, first, "queued", 0)
    _sent(s, sent, second, "accepted", 5)
    failed = _signed(s, chart)
    _sent(s, failed, first, "error", 1, error_code="900", error_message="synthetic failure")
    unsent = _signed(s, chart)
    s.commit()
    with portal_engine.begin() as c:
        mine = _read(c, chart)
    assert set(mine) == {sent.id, failed.id, unsent.id}
    assert (mine[sent.id].pharmacy_name, mine[sent.id].transmission_status) == (
        "Test Pharmacy Two", "accepted")                       # the latest NewRx wins
    assert (mine[failed.id].pharmacy_name, mine[failed.id].transmission_status) == (
        "Test Pharmacy One", "error")
    assert (mine[unsent.id].pharmacy_name, mine[unsent.id].transmission_status) == (None, None)


@pytest.mark.db
def test_drafts_entered_in_error_reported_and_other_patients_prescriptions_never_appear(
        portal_engine: Engine, admin_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    pharmacy = _pharmacy(admin_engine, "Test Pharmacy")
    me, ctx = chart["me"], chart["ctx"]
    draft = b.prescription(s, me["pt"], me["enc"], ctx)
    withdrawn = b.prescription(s, me["pt"], me["enc"], ctx)
    s.flush()
    withdrawn.status = "entered-in-error"
    reported = M["medication_request"](
        status="active", intent="plan", reported_boolean=True, subject_patient_id=me["pt"].id,
        requester_patient_id=me["pt"].id, authored_on=b.NOW,
        medication_codeable_concept_text="Synthetic reported medication")
    s.add(reported)
    theirs = _signed(s, chart, "other")
    _sent(s, theirs, pharmacy, "sent", 0)
    s.commit()
    with portal_engine.begin() as c:
        mine = _read(c, chart)
        assert not {draft.id, withdrawn.id, reported.id, theirs.id} & set(mine)
        assert set(_read(c, chart, "other")) == {theirs.id}
        c.execute(text("SELECT set_config('app.current_patient_id', '', true)"))
        assert c.execute(text(READ)).all() == []               # no session patient, nothing


@pytest.mark.db
def test_only_three_columns_execute_for_shri_portal_only_and_no_table_privilege(
        admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        columns = c.execute(text(
            "SELECT array_agg(a ORDER BY o) FROM pg_proc p, unnest(p.proargnames, "
            "p.proargmodes::text[]) WITH ORDINALITY u(a, m, o) WHERE p.oid = "
            "'admin.portal_prescription_transmissions'::regproc AND m = 't'")).scalar()
        assert columns == ["medication_request_id", "pharmacy_name", "transmission_status"]
        execute = {role: c.execute(text(
            "SELECT has_function_privilege(:r, 'admin.portal_prescription_transmissions()', "
            "'EXECUTE')"), {"r": role}).scalar()
            for role in ("shri_portal", "shri_app", "shri_fhir_reader", "shri_integration")}
        assert execute == {"shri_portal": True, "shri_app": False, "shri_fhir_reader": False,
                           "shri_integration": False}
        assert c.execute(text(
            "SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'] "
            "AND pg_get_userbyid(p.proowner) = 'shri_migrator' FROM pg_proc p WHERE p.oid = "
            "'admin.portal_prescription_transmissions'::regproc")).scalar()
        assert not c.execute(text(
            "SELECT bool_or(has_table_privilege('shri_portal', t, 'SELECT')) FROM unnest("
            "ARRAY['admin.pharmacy', 'admin.erx_transaction']) t")).scalar()
