"""Audit coverage of Anand's state-changing operations (SECURITY_MODEL §6; core/audit.py).

Core writes the audit row from the contract's x-audit, so an operation is covered when a live
test calls it and checks that row with ``audit_problems``: the action and category the contract
gives, the clinic, the patient (or none) and a success outcome, found by the response's
X-Request-ID (the row's ``correlation_id``). ``phi_in`` checks that no patient data is in an
audit reason or an error body. ``OWNED_WRITES`` names the test for each operation, and
test_audit_coverage.py fails when a served one is missing. Synthetic data only.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import Engine, text

from app.core.audit import event_action
from app.core.operations import load_operations
from app.core.request_id import REQUEST_ID_HEADER

# Every served operation with x-owner anand that changes data, and the live test that checks
# its audit row. createCardSession joins when it is built.
OWNED_WRITES = {
    "recordPayment": "app/modules/billing/tests/test_payments_live.py::"
                     "test_a_payment_is_audited_with_its_patient_and_no_patient_data",
    "createUploadUrl": "app/modules/files/tests/test_files_live.py::"
                       "test_an_upload_is_audited_with_no_patient_data",
    "completeUpload": "app/modules/files/tests/test_files_live.py::"
                      "test_an_upload_is_audited_with_no_patient_data",
    "updateFacility": "app/modules/practice_setup/tests/test_facility_edit_live.py::"
                      "test_a_facility_change_is_audited_as_a_config_change",
    "createProvider": "app/modules/practice_setup/tests/test_provider_create_live.py::"
                      "test_a_provider_and_a_schedule_are_audited_as_config_changes",
    "createProviderSchedule": "app/modules/practice_setup/tests/test_provider_create_live.py::"
                              "test_a_provider_and_a_schedule_are_audited_as_config_changes",
    "updatePracticeSettings": "app/modules/practice_setup/tests/test_practice_settings_live.py::"
                              "test_a_settings_change_is_audited_as_a_config_change",
}


def audit_rows(admin: Engine, response: Any) -> list[Any]:
    """The audit rows the request wrote, read as the master user."""
    with admin.connect() as c:
        return list(c.execute(text(
            "SELECT action, category, outcome, tenant_id, patient_id, entity_id, reason "
            "FROM audit.audit_event WHERE correlation_id = :r ORDER BY chain_seq"),
            {"r": response.headers[REQUEST_ID_HEADER]}))


def audit_problems(admin: Engine, response: Any, operation_id: str, *, tenant: UUID,
                   patient: UUID | None = None, entity: object | None = None) -> list[str]:
    """What is wrong with the request's audit row against the operation's x-audit; empty when
    there is one success row with the contract's action and category, the clinic, the patient
    (none when the contract names none) and, if given, the record."""
    operation = load_operations()[operation_id]
    want = (event_action(operation), operation.audit.category)
    rows = audit_rows(admin, response)
    mine = [r for r in rows if (r.action, r.category) == want]
    if len(mine) != 1:
        return [f"{operation_id}: {len(mine)} rows with {want}, in "
                f"{[(r.action, r.category) for r in rows]}"]
    row, problems = mine[0], []
    if row.outcome != "success":
        problems.append(f"{operation_id}: outcome {row.outcome}")
    if row.tenant_id != tenant:
        problems.append(f"{operation_id}: the row is in another clinic")
    if operation.audit.patient is None and patient is not None:
        problems.append(f"{operation_id}: the contract names no patient, the test does")
    if row.patient_id != patient:
        problems.append(f"{operation_id}: patient {row.patient_id}, expected {patient}")
    if entity is not None and row.entity_id != str(entity):
        problems.append(f"{operation_id}: record {row.entity_id}, expected {entity}")
    return problems


def phi_in(texts: Iterable[str | None], phi: Iterable[str]) -> list[str]:
    """The patient data (names, birth date, MRN, phone) found in any of the texts, as whole
    words, so a short name doesn't match inside another word ("Mai" in "domain")."""
    found = []
    for t in texts:
        for value in phi:
            if t and value and re.search(rf"(?<!\w){re.escape(value)}(?!\w)", t, re.I):
                found.append(value)
    return found
