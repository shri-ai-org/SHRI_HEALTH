"""One model call with its budget check and its request record, for the morning brief and the
differential (morning_briefs.py, differentials.py; D116). The same steps as chart_answers.py:
the month's budget first (BudgetReached, recorded ``blocked``), then the call (ModelUnavailable,
recorded ``failed`` or ``timeout``), then the reply parsed as JSON. The record keeps hashes,
token counts and the records sent (``ai_request_input_ref``), never text; the log line names
the request, its status, model and token counts only.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.long_running import Operation, create_operation, finish_operation, problem_body
from app.core.request_id import current_request_id
from app.db.models.enums import AIFeature, AIRequestStatus

from . import budget
from .model_client import ModelClient, ModelError, ModelReply
from .repository import AIRepository, RequestRecord
from .schemas import PIPELINE_VERSION, SourceRef
from .service import BudgetReached, ModelUnavailable, OutputRejected, parse

log = logging.getLogger("app.modules.ai.gateway")


@dataclass(frozen=True)
class Call:
    feature: AIFeature
    name: str  # the log's feature name, e.g. "morning-brief"
    messages: list[dict[str, str]]
    schema: dict[str, Any]
    max_tokens: int
    sources: Sequence[SourceRef]
    patient_id: UUID | None = None
    encounter_id: UUID | None = None


@dataclass(frozen=True)
class Reply:
    raw: Any
    reply: ModelReply


class Recorder:
    """Writes the call's request record once its outcome is known."""

    def __init__(self, db: AsyncSession, repo: AIRepository, model: ModelClient,
                 call: Call) -> None:
        self.db, self.repo, self.model, self.call = db, repo, model, call
        self.digest = hashlib.sha256(
            json.dumps(call.messages, sort_keys=True).encode()).hexdigest()

    async def __call__(self, status: AIRequestStatus, reply: ModelReply | None,
                       error: str | ModelError | None) -> UUID:
        failed = error if isinstance(error, ModelError) else None
        request_id, _ = await self.repo.record_request(self.db, RequestRecord(
            feature=self.call.feature, status=status, pipeline_version=PIPELINE_VERSION,
            model_name=reply.model if reply else (failed.model if failed and failed.model
                                                  else self.model.model),
            prompt_template_id=None, input_sha256=self.digest,
            patient_id=self.call.patient_id, encounter_id=self.call.encounter_id,
            latency_ms=reply.latency_ms if reply else None,
            input_tokens=reply.prompt_tokens if reply else (
                failed.prompt_tokens if failed else None),
            output_tokens=reply.completion_tokens if reply else (
                failed.completion_tokens if failed else None),
            error_message=str(error) if error is not None else None,
            correlation_id=current_request_id(),
            sources=tuple(dict.fromkeys(self.call.sources))))
        log.info("ai.request id=%s feature=%s status=%s model=%s latency_ms=%s tokens_in=%s "
                 "tokens_out=%s request=%s", request_id, self.call.name, status.value,
                 reply.model if reply else "-", reply.latency_ms if reply else "-",
                 reply.prompt_tokens if reply else "-",
                 reply.completion_tokens if reply else "-", current_request_id() or "-")
        return request_id


async def complete(db: AsyncSession, repo: AIRepository, model: ModelClient, call: Call
                   ) -> tuple[Reply, Recorder]:
    """The budget check and the call. The caller records the outcome with the Recorder once it
    has checked the reply (completed, or failed with output-rejected)."""
    record = Recorder(db, repo, model, call)
    if budget.price(model.model) is not None and budget.estimate(
            await repo.month_usage(db)) >= budget.limit():
        raise BudgetReached(await record(AIRequestStatus.BLOCKED, None,
                                         "budget-reached: the month's AI budget is used up"))
    try:
        reply = await model.complete(call.messages, max_tokens=call.max_tokens,
                                     schema=call.schema)
    except ModelError as err:
        status = AIRequestStatus.TIMEOUT if err.kind == "timeout" else AIRequestStatus.FAILED
        raise ModelUnavailable(await record(status, None, err)) from None
    return Reply(parse(reply.content), reply), record


async def as_operation(db: AsyncSession, kind: str, result_type: str,
                       work: Callable[[], Awaitable[UUID]]) -> Operation:
    """Runs the work inside the request as one operation, finished before the 202 (as the chart
    summary and answer do), and commits. A failure becomes the operation's error, in the
    catalogue's words only: ``ai-unavailable`` or ``ai-output-rejected``."""
    operation = await create_operation(db, kind)
    try:
        result_id = await work()
    except BudgetReached:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable",
            "The month's AI budget is used up; it resumes next month (ai-unavailable)"))
    except ModelUnavailable:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable", "The AI model is unavailable (ai-unavailable)"))
    except OutputRejected:
        done = await finish_operation(db, operation.id, "failed", error=problem_body(
            "service-unavailable", "The AI output failed validation (ai-output-rejected)"))
    else:
        done = await finish_operation(db, operation.id, "succeeded",
                                      result=(result_type, result_id))
    await db.commit()
    return done
