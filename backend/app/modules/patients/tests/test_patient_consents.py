"""Patient.consents (D120, #428): the current consent of each kind, mapped from the helper's rows.
Synthetic values only."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from app.db.fhir_store import ConsentOnFile
from app.modules.patients.repository import _current_consents


def _row(kind: str, *, decision: str | None = "permit", signed: datetime | None = None,
         user: uuid.UUID | None = None, name: str | None = None) -> ConsentOnFile:
    return ConsentOnFile(consent_id=uuid.uuid4(), kind=kind, status="active", decision=decision,
                         date_time=signed, policy_version="2026-10",
                         recorded_at=datetime(2026, 11, 3, 15, 5, tzinfo=UTC),
                         recorded_by_user_id=user, recorded_by_name=name)


def test_one_per_kind_newest_first_with_who_recorded_it() -> None:
    clerk = uuid.uuid4()
    newest = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
    out = _current_consents([
        _row("privacy-notice", user=clerk, name="Kaia401 Lindgren118"),
        _row("treatment", decision="deny", signed=newest, user=clerk, name="Kaia401 Lindgren118"),
        _row("treatment", signed=datetime(2026, 11, 1, tzinfo=UTC))])
    assert [(c.kind, c.decision) for c in out] == [("privacy-notice", "permit"),
                                                     ("treatment", "deny")]
    assert out[1].signed_at == newest
    assert out[0].recorded_by is not None and out[0].recorded_by.id == clerk
    dumped = out[0].model_dump(by_alias=True, exclude_none=True)
    assert set(dumped) == {"kind", "decision", "signedAt", "policyVersion", "recordedBy"}


def test_no_provision_reads_as_permit_and_an_import_has_no_recorder() -> None:
    (only,) = _current_consents([_row("financial", decision=None)])
    assert only.decision == "permit" and only.recorded_by is None
    assert only.signed_at == datetime(2026, 11, 3, 15, 5, tzinfo=UTC)  # falls back to recorded
