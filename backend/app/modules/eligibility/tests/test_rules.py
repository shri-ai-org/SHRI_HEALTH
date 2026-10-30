"""The pure rules, no database: the 270 built from a check's data, each recorded 271 turned into
what it changes on the check, and the copay and deductible picked from the benefit lines.
Synthetic data only."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import UUID

import pytest

from app.core.errors import ValidationFailed

from .. import service
from ..messages import EligibilityResponse
from ..repository import BenefitRow, Person, Reply, RequestData
from .schema_check import errors
from .test_messages import REQUEST, example

CHECK = UUID("3a4b5c6d-7e8f-4a9b-9c0d-1e2f3a4b5c6d")
NOW = datetime(2026, 11, 3, 14, 52, 1, 123456, tzinfo=UTC)
KAIA = Person(family="Lindgren118", given=("Kaia401",), birth_date=date(1990, 3, 14))


def _data(**changes: object) -> RequestData:
    base = RequestData(
        check_id=CHECK, status="pending", service_date=date(2026, 11, 3),
        service_type_codes=("30",), provider_npi="1234567893",
        payer_name="Example Health Plan (synthetic)", payer_clearinghouse_id="TESTPAYER01",
        relationship="self", member_id="TEST-M0012345", subscriber_id=None,
        group_number="TEST-G778", patient=KAIA, subscriber=None)
    return RequestData(**{**base.__dict__, **changes})


# ----------------------------------------------------------------------------------- the 270
def test_the_request_for_a_subscriber_is_the_recorded_example() -> None:
    built = service.request_from(_data(), NOW).as_json()
    assert errors(REQUEST, built) == []
    assert built == example("request-subscriber.json")  # createdAt in whole seconds, UTC


def test_the_request_for_a_dependent() -> None:
    marcus = Person(family="Okafor904", given=("Marcus217",), birth_date=date(2014, 2, 11))
    ngozi = Person(family="Okafor904", given=("Ngozi311",), birth_date=date(1981, 7, 22))
    built = service.request_from(_data(
        check_id=UUID("4b5c6d7e-8f9a-4b0c-8d1e-2f3a4b5c6d7e"), relationship="child",
        member_id="TEST-S0098765-02", subscriber_id="TEST-S0098765", patient=marcus,
        subscriber=ngozi, payer_clearinghouse_id=None, group_number=None,
        service_date=date(2026, 11, 4), service_type_codes=("30", "98")),
        datetime(2026, 11, 3, 15, 10, tzinfo=UTC)).as_json()
    assert errors(REQUEST, built) == []
    assert built == example("request-dependent.json")


def test_a_dependent_with_the_subscribers_member_id_sends_it_once() -> None:
    marcus = Person(family="Okafor904", given=("Marcus217",), birth_date=date(2014, 2, 11))
    built = service.request_from(_data(relationship="child", patient=marcus,
                                       subscriber=KAIA), NOW).as_json()
    assert built["subscriber"]["memberId"] == "TEST-M0012345"
    assert "memberId" not in built["dependent"]


@pytest.mark.parametrize(("changes", "code"), [
    ({"payer_name": None}, "payer-missing"),
    ({"provider_npi": None}, "provider-npi-missing"),
    ({"member_id": None}, "member-id-missing"),
    ({"relationship": "spouse", "subscriber": None}, "subscriber-missing"),
    ({"patient": Person(family="Lindgren118", given=(), birth_date=None)},
     "birth-date-missing"),
    ({"patient": Person(family=None, given=("Kaia401",), birth_date=date(1990, 3, 14))},
     "name-missing"),
])
def test_a_request_that_cannot_be_built_says_why_without_patient_data(
        changes: dict[str, object], code: str) -> None:
    with pytest.raises(service.RequestNotBuildable) as refused:
        service.request_from(_data(**changes), NOW)
    assert refused.value.code == code


# ----------------------------------------------------------------------------------- the 271
def _reply(name: str) -> Reply:
    return service.reply_from(EligibilityResponse.model_validate(example(name)))


def test_an_active_reply() -> None:
    reply = _reply("response-active-copay.json")
    assert (reply.status, reply.plan_name, reply.coverage_start, reply.coverage_end) == (
        "active", "Test PPO", date(2026, 1, 1), None)
    assert reply.responded_at == datetime(2026, 11, 3, 14, 52, 9, tzinfo=UTC)
    assert reply.expires_at == reply.responded_at + timedelta(hours=24)
    assert reply.error_code is None and len(reply.benefits) == 9
    assert reply.benefits[6].percent == Decimal("20")
    assert service.summarize(reply.benefits) == (Decimal("25.00"), Decimal("1500.00"),
                                                 Decimal("640.00"))


def test_an_inactive_reply() -> None:
    reply = _reply("response-inactive.json")
    assert (reply.status, reply.coverage_end, reply.benefits) == (
        "inactive", date(2026, 6, 30), ())


def test_a_payer_error_never_keeps_the_payers_text() -> None:
    reply = _reply("response-payer-error.json")
    assert (reply.status, reply.error_code) == ("error", "72")
    assert reply.error_message == "The payer reports an invalid member ID."
    assert reply.expires_at is None
    unknown = example("response-payer-error.json") | {"errors": [{"code": "ZZ"}]}
    parsed = service.reply_from(EligibilityResponse.model_validate(unknown))
    assert parsed.error_message == service.GENERIC_ERROR


def test_member_not_found_is_complete_and_unknown() -> None:
    reply = _reply("response-member-not-found.json")
    assert (reply.status, reply.error_code, reply.error_message) == ("not-found", None, None)


def test_a_reply_that_breaks_its_shape_names_where_never_what() -> None:
    bad = example("response-active-copay.json")
    bad["benefits"][1]["amount"]["value"] = "25"
    bad["correlationId"] = "Lindgren118"
    with pytest.raises(ValidationFailed) as refused:
        service.parse_response(bad)
    found = refused.value.extensions["errors"]
    assert {e["pointer"] for e in found} == {"/correlationId", "/benefits/1/amount/value"}
    assert "Lindgren118" not in repr(found)


# ------------------------------------------------------------------------- copay and deductible
def _line(kind: str, amount: str, **kw: str | None) -> BenefitRow:
    fields: dict[str, str | None] = {"service_type_code": "30", "coverage_level": "individual",
                                     "network": "in", "time_period": None} | kw
    return BenefitRow(benefit_type=kind, amount=Decimal(amount), percent=None,
                      authorization_required=None, message=None, **fields)


def test_the_copay_prefers_the_office_visit_in_network() -> None:
    lines = [_line("copay", "40.00", service_type_code="30", time_period="visit"),
             _line("copay", "60.00", service_type_code="98", time_period="visit",
                   network="out"),
             _line("copay", "25.00", service_type_code="98", time_period="visit"),
             _line("copay", "10.00", service_type_code="98", time_period="visit",
                   coverage_level="family")]
    assert service.summarize(lines)[0] == Decimal("25.00")
    assert service.summarize(lines[:2])[0] == Decimal("40.00")
    assert service.summarize(lines[1:2]) == (None, None, None)  # out of network only


def test_the_deductible_prefers_the_calendar_year_and_reads_what_remains() -> None:
    lines = [_line("deductible", "2000.00", time_period="plan-year"),
             _line("deductible", "1500.00", time_period="calendar-year"),
             _line("deductible", "640.00", time_period="remaining"),
             _line("deductible", "3000.00", time_period="calendar-year",
                   coverage_level="family")]
    assert service.summarize(lines)[1:] == (Decimal("1500.00"), Decimal("640.00"))
    assert service.summarize(lines[:1])[1:] == (Decimal("2000.00"), None)
