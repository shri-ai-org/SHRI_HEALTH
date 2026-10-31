"""The fixed safety rules (rules.py; D99), the signing refusals and the NewRx builder, as pure
functions: each rule positive, negative, entered-in-error ignored, inactive ignored. No database.
Synthetic data only."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from app.db.models.systems import NDC, RXNORM
from app.modules.eligibility.tests.schema_check import errors

from .. import rules, service
from ..repository import AlertRow, Drug, NewRxData, PrescriptionRow
from .fakes import AMOXICILLIN as FAKE_AMOXICILLIN
from .fakes import NOW
from .test_messages import NEW_RX

AMOXICILLIN = rules.Drug(name="amoxicillin 500 MG Oral Capsule", ingredients=frozenset({"723"}),
                         ingredient_names={"723": "amoxicillin"})
COMBO = rules.Drug(name="amoxicillin / clavulanate 875 MG / 125 MG Oral Tablet",
                   ingredients=frozenset({"723", "48203"}))


def _allergy(ingredients: set[str], status: str | None = "active",
             verification: str | None = "confirmed") -> rules.Allergy:
    return rules.Allergy(id=uuid4(), clinical_status=status, verification_status=verification,
                         name="amoxicillin", ingredients=frozenset(ingredients))


def _entry(ingredients: set[str], status: str = "active") -> rules.ListEntry:
    return rules.ListEntry(id=uuid4(), status=status, name="Amoxicillin 250 mg",
                           ingredients=frozenset(ingredients))


# ------------------------------------------------------------------------------ allergy
def test_an_allergy_to_an_ingredient_raises_a_high_alert() -> None:
    allergy = _allergy({"723"})
    [alert] = rules.allergy_alerts(COMBO, [allergy])
    assert (alert.kind, alert.severity, alert.allergy_id, alert.rule_code) == (
        "allergy", "high", allergy.id, "allergy")
    assert alert.medication_id is None and "amoxicillin" in alert.message


def test_an_allergy_to_another_ingredient_raises_nothing() -> None:
    assert rules.allergy_alerts(AMOXICILLIN, [_allergy({"7980"})]) == []  # penicillin G
    assert rules.allergy_alerts(rules.Drug("Fish oil", frozenset()), [_allergy({"723"})]) == []


@pytest.mark.parametrize("verification", ["entered-in-error", "refuted"])
def test_an_allergy_entered_in_error_or_refuted_is_ignored(verification: str) -> None:
    assert rules.allergy_alerts(AMOXICILLIN, [_allergy({"723"}, None, verification)]) == []
    assert rules.allergy_alerts(AMOXICILLIN, [_allergy({"723"}, "active", verification)]) == []


@pytest.mark.parametrize("status", ["inactive", "resolved", None])
def test_an_inactive_allergy_is_ignored(status: str | None) -> None:
    assert rules.allergy_alerts(AMOXICILLIN, [_allergy({"723"}, status)]) == []


def test_unconfirmed_and_unstated_allergies_count() -> None:
    assert len(rules.allergy_alerts(AMOXICILLIN, [_allergy({"723"}, "active", "unconfirmed"),
                                                  _allergy({"723"}, "active", None)])) == 2


# ------------------------------------------------------------------------------ duplicate
def test_an_active_medication_with_the_same_ingredient_raises_a_warning() -> None:
    entry = _entry({"723"})
    [alert] = rules.duplicate_alerts(COMBO, [entry])
    assert (alert.kind, alert.severity, alert.medication_id, alert.rule_code) == (
        "duplicate-medication", "warning", entry.id, "duplicate-medication")
    assert alert.allergy_id is None


def test_a_medication_with_other_ingredients_raises_nothing() -> None:
    assert rules.duplicate_alerts(AMOXICILLIN, [_entry({"29046"})]) == []  # lisinopril


def test_an_entered_in_error_medication_is_ignored() -> None:
    assert rules.duplicate_alerts(AMOXICILLIN, [_entry({"723"}, "entered-in-error")]) == []


@pytest.mark.parametrize("status", ["stopped", "completed", "cancelled", "draft", "on-hold"])
def test_an_inactive_medication_is_ignored(status: str) -> None:
    assert rules.duplicate_alerts(AMOXICILLIN, [_entry({"723"}, status)]) == []


def test_check_runs_both_rules_allergies_first_and_messages_fit() -> None:
    long = rules.Drug(name="x" * 600, ingredients=frozenset({"723"}))
    found = rules.check(long, [_allergy({"723"})], [_entry({"723"})])
    assert [a.kind for a in found] == ["allergy", "duplicate-medication"]
    assert all(len(a.message) <= rules.MESSAGE_MAX for a in found)


# --------------------------------------------------------------------- signing refusals
def _alert(severity: str, overridden: bool = False) -> AlertRow:
    return AlertRow(id=uuid4(), code="ALGY", severity=severity, message="m", allergy_id=None,
                    medication_id=None, override_reason="ok" if overridden else None,
                    overridden_by=None, overridden_at=NOW if overridden else None)


def test_sign_refusals_follow_the_helpers_order() -> None:
    row = PrescriptionRow(
        id=uuid4(), patient_id=uuid4(), encounter_id=None, facility_id=None, status="draft",
        drug=FAKE_AMOXICILLIN, dosage_text=" ", quantity_value=None, quantity_unit=None,
        days_supply=None, refills=None, substitution_allowed=None, pharmacy_id=None,
        note_to_pharmacy=None, dea_schedule=None, signed_by=None, signed_at=None, version=1,
        safety_checked_at=None, created_at=NOW, updated_at=NOW, alerts=(), transmission=None)
    assert service.sign_refusals(row) == [("/dosageText", "required"), ("/quantity", "required"),
                                          ("/pharmacyId", "required"),
                                          ("/alerts", "safety-check-stale")]
    ready = replace(row, dosage_text="1 daily", quantity_value=Decimal(1), quantity_unit="tablet",
                    pharmacy_id=uuid4(), safety_checked_at=NOW,
                    alerts=(_alert("moderate"), _alert("high", True), _alert("high")))
    assert service.sign_refusals(ready) == [("/alerts/2", "override-required")]


# --------------------------------------------------------------------------- the NewRx
def _data(**changes: object) -> NewRxData:
    base = NewRxData(
        prescription_id=uuid4(), status="active", intent="order",
        signed_at=datetime(2026, 11, 20, 15, 23, 0, 412000, tzinfo=UTC),
        drug=Drug(RXNORM, "308191", "amoxicillin 500 MG Oral Capsule",
                  "Amoxicillin 500 mg capsule"),
        sig="1 capsule by mouth three times daily for 10 days",
        quantity_value=Decimal("30.000"), quantity_unit="capsule", days_supply=Decimal(10),
        refills=None, substitution_allowed=None, dea_schedule=None, note_to_pharmacy=" ",
        patient_family="Lindgren118", patient_given=("Kaia401",),
        patient_birth_date=date(1990, 3, 14), prescriber_npi="1234567893",
        prescriber_family="Lindqvist58", prescriber_given=(), pharmacy_ncpdp_id="0000012",
        pharmacy_npi=None)
    return replace(base, **changes)  # type: ignore[arg-type]


def test_the_new_rx_is_valid_under_its_schema() -> None:
    data = _data()
    message = service.new_rx_from(data, NOW).as_json()
    assert errors(NEW_RX, message) == []
    assert message["correlationId"] == str(data.prescription_id)
    assert message["signedAt"] == "2026-11-20T15:23:00Z"
    assert message["medication"] == {
        "rxnormCode": "308191", "description": "amoxicillin 500 MG Oral Capsule",
        "quantity": {"value": "30", "unit": "capsule"}, "daysSupply": 10, "refills": 0,
        "substitutionAllowed": True, "sig": "1 capsule by mouth three times daily for 10 days"}
    assert message["prescriber"] == {"npi": "1234567893", "name": {"family": "Lindqvist58"}}
    assert message["pharmacy"] == {"ncpdpId": "0000012"}


def test_the_new_rx_of_a_drug_written_as_text_or_ndc() -> None:
    for drug in (Drug(None, None, None, "Saline nasal spray"),
                 Drug(NDC, "00000-0000-00", None, "Saline nasal spray")):
        message = service.new_rx_from(_data(drug=drug, quantity_value=Decimal("44.50")),
                                      NOW).as_json()
        assert "rxnormCode" not in message["medication"]
        assert message["medication"]["description"] == "Saline nasal spray"
        assert message["medication"]["quantity"]["value"] == "44.5"
        assert errors(NEW_RX, message) == []


@pytest.mark.parametrize(("changes", "code"), [
    ({"status": "draft"}, "prescription-not-signed"),
    ({"signed_at": None}, "prescription-not-signed"),
    ({"intent": "plan"}, "prescription-not-signed"),
    ({"drug": Drug(None, None, None, None)}, "drug-missing"),
    ({"sig": "  "}, "sig-missing"),
    ({"quantity_value": None}, "quantity-missing"),
    ({"pharmacy_ncpdp_id": None}, "pharmacy-missing"),
    ({"prescriber_npi": None}, "prescriber-npi-missing"),
    ({"prescriber_family": None}, "prescriber-name-missing"),
    ({"patient_family": None}, "name-missing"),
    ({"patient_birth_date": None}, "birth-date-missing"),
    ({"quantity_value": Decimal("0.0001")}, "invalid-field"),
])
def test_a_new_rx_that_cant_be_built_names_why_without_patient_data(
        changes: dict[str, object], code: str) -> None:
    with pytest.raises(service.MessageNotBuildable) as refused:
        service.new_rx_from(_data(**changes), NOW)
    assert refused.value.code == code
