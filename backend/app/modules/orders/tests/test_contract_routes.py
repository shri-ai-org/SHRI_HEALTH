"""The orders module's operations are built or still pending: the doctor's reads of lab results
and imaging reports (13 Nov). Orders, the compendium and filing come in batch 5."""

from app.modules.patients.tests.contract_routes import progress_problems

MODULE = "orders"

READS = frozenset({"listLabResults", "listImagingReports"})
PENDING: frozenset[str] = frozenset()


def test_orders_operations_are_built_or_pending() -> None:
    assert progress_problems(MODULE, READS, PENDING) == []
