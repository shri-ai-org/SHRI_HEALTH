"""The rules behind AI-02's routes (contracts/openapi/modules/ai.yaml): createChartSummary
(#111) and getChartSummary (#112). The summary itself is summary.py.

**createChartSummary**, synchronously, in order:

1. ``409 feature-disabled`` while AI or ``chart-summary`` is off for the clinic;
2. ``404`` for a patient the clinic can't see, ``403 break-glass-required`` for a restricted
   chart (D37), through core's chart check;
3. with ``encounterId``: ``404`` for an encounter the user can't see (facility), and ``422
   business-rule-violation`` (``/encounterId`` ``invalid-reference``) when it is another
   patient's.

Then the operation (``ai.chart-summary``) and the summary run in the request, as the note draft
does: the ``202`` carries the finished operation, ``succeeded`` with result ``{type:
chart-summary, id}``, or ``failed`` with a Problem (``ai-unavailable`` or ``ai-output-rejected``
in the detail, until core's catalogue has those codes). One commit, with the audit row (x-audit
``ai``, patient from the body).

**getChartSummary**: the summary, for a user who may read the patient's chart (D37); ``404``
for one the clinic can't see. Still readable with AI off.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import NotFound, ValidationFailed, field_error
from app.core.long_running import Operation, create_operation, finish_operation, problem_body
from app.db.models.enums import AIFeature

from .model_client import ModelClient
from .repository import AIRepository
from .schemas import (
    ChartSummary,
    ChartSummaryCreate,
    ChartSummaryGap,
    ChartSummarySection,
    ChartSummaryStatement,
)
from .service import BudgetReached, ModelUnavailable, OutputRejected, ensure_enabled
from .summary import CHART_SUMMARY, SummaryChart, SummaryRequest, summarize

SUMMARY_KIND = "ai.chart-summary"
ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[object]]


class VisitOf(Protocol):
    """The encounter as the user may read it (facility, D37): its patient and its reason."""

    async def __call__(self, db: AsyncSession, user: CurrentUser, encounter_id: UUID
                      ) -> tuple[UUID, str | None]: ...


class SummaryReader(Protocol):
    async def __call__(self, db: AsyncSession, user: CurrentUser, patient_id: UUID
                       ) -> SummaryChart: ...


async def create(db: AsyncSession, repo: AIRepository, model: ModelClient, check: ChartCheck,
                 visit_of: VisitOf, read: SummaryReader, user: CurrentUser,
                 body: ChartSummaryCreate) -> Operation:
    await ensure_enabled(db, repo, AIFeature.CHART_SUMMARY)
    await check(db, user, body.patient_id)        # 404 unknown, 403 restricted (D37)
    reason = None
    if body.encounter_id is not None:
        patient, reason = await visit_of(db, user, body.encounter_id)
        if patient != body.patient_id:
            raise ValidationFailed(code="business-rule-violation", errors=[
                field_error("body", "/encounterId", "invalid-reference")])
    chart = await read(db, user, body.patient_id)
    request = SummaryRequest(
        patient_id=body.patient_id, encounter_id=body.encounter_id,
        patient_context=await repo.patient_context(db, body.patient_id),
        chart=SummaryChart(lines=chart.lines, unavailable=chart.unavailable,
                           reason_for_visit=reason))
    operation = await create_operation(db, SUMMARY_KIND)
    try:
        summary_id = await summarize(db, repo, model, request)
    except BudgetReached:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable",
            "The month's AI budget is used up; AI summaries resume next month (ai-unavailable)"))
    except ModelUnavailable:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable", "The AI model is unavailable (ai-unavailable)"))
    except OutputRejected:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable", "The AI output failed validation (ai-output-rejected)"))
    else:
        done = await finish_operation(db, operation.id, "succeeded",
                                      result=("chart-summary", summary_id))
    await db.commit()
    return done


async def get(db: AsyncSession, repo: AIRepository, check: ChartCheck, user: CurrentUser,
              summary_id: UUID) -> ChartSummary:
    found = await repo.suggestion(db, summary_id)
    if found is None or found.target_resource_type != CHART_SUMMARY \
            or found.patient_id is None:
        raise NotFound()
    await check(db, user, found.patient_id)       # D37, as for any read of the chart
    view = (await repo.suggestion_views(db, [summary_id]))[summary_id]
    return as_contract(summary_id, found.patient_id, found.encounter_id, found.content,
                       view)


def as_contract(summary_id: UUID, patient_id: UUID, encounter_id: UUID | None,
                content: dict[str, Any], view: Any) -> ChartSummary:
    return ChartSummary(
        id=summary_id, patient_id=patient_id, encounter_id=encounter_id,
        sections=[ChartSummarySection(topic=s["topic"], statements=[
            ChartSummaryStatement.model_validate(st) for st in s["statements"]])
            for s in content.get("sections", [])],
        missing=[ChartSummaryGap.model_validate(g) for g in content.get("missing", [])],
        suggestion=view, created_at=view.created_at)
