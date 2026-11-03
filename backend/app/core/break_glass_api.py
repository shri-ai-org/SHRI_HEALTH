"""POST /patients/{patientId}/break-glass (contract operation breakGlass, x-owner thulasi):
open a restricted chart for 4 hours with a stated reason (SECURITY_MODEL §5.2, D37, D53).

The grant is for this user and this patient only and never widens permissions: it is the row
`access.chart_access()` looks for, so `ensure_chart_access()` lets the user in until it expires.
The decision uses `chart_access()`, the read-only sibling of `ensure_chart_access()`: a blocked
chart is exactly the case this route exists for, so it must not answer 403 here.

Audited as `security` with the patient (x-audit), the reason code and text on the audit row
(the text may name people: it is never logged). Raises `break-glass.granted` (internal: the
privacy officer's inbox item, EVENTS.md §4) in the same transaction.
"""

from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, FastAPI, Path, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.access import ChartAccess, chart_access
from app.core.audit import audit_detail
from app.core.config import Settings
from app.core.deps import CurrentUser, require, tenant_db
from app.core.errors import Conflict, NotFound, ValidationFailed, field_error
from app.core.routing import API_PREFIX

router = APIRouter(tags=["platform"])

GRANT_HOURS = 4  # D53

# One grant at a time per user and chart: two requests at once wait here, and the second sees
# the first one's grant (409).
_LOCK = text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))")
_MERGED = text("SELECT EXISTS (SELECT 1 FROM clinical.patient_link "
               "WHERE patient_id = :p AND type = 'replaced-by')")
_GRANT = text("""
INSERT INTO audit.break_glass_access
    (id, tenant_id, patient_id, user_id, reason_code, reason_text, granted_at, expires_at)
VALUES (:id, :tenant, :patient, :user, :code, :text, now(),
        now() + make_interval(hours => :hours))
RETURNING granted_at, expires_at
""")

_REFUSED = {
    ChartAccess.OPEN: "This chart is not restricted",
    ChartAccess.CARE_TEAM: "You are on this patient's care team and don't need emergency access",
    ChartAccess.BREAK_GLASS: "You already have emergency access to this chart",
}


class BreakGlassRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason_code: Literal["emergency-care", "continuity-of-care", "patient-request", "other"] = (
        Field(alias="reasonCode"))
    reason_text: str | None = Field(default=None, alias="reasonText", min_length=1,
                                    max_length=500)


def _time(value: Any) -> str:
    return str(value.isoformat().replace("+00:00", "Z"))


@router.post("/patients/{patientId}/break-glass", operation_id="breakGlass")
async def break_glass(
    request: Request,
    patient_id: Annotated[UUID, Path(alias="patientId")],
    body: BreakGlassRequest,
    user: CurrentUser = Depends(require("patients:break-glass")),
    db: AsyncSession = Depends(tenant_db),
) -> dict[str, Any]:
    reason_text = body.reason_text.strip() if body.reason_text else None
    if body.reason_code == "other" and not reason_text:
        raise ValidationFailed("State the reason in reasonText", code="business-rule-violation",
                               errors=[field_error("body", "/reasonText", "required")])
    await db.execute(_LOCK, {"key": f"break-glass:{user.id}:{patient_id}"})
    access = await chart_access(db, user, patient_id)
    if access is ChartAccess.NOT_FOUND:
        raise NotFound()
    if (await db.execute(_MERGED, {"p": patient_id})).scalar_one():
        raise Conflict(code="patient-merged")
    if access is not ChartAccess.BLOCKED:
        raise Conflict(_REFUSED[access])
    grant_id = uuid4()
    granted = (await db.execute(_GRANT, {
        "id": grant_id, "tenant": user.organization_id, "patient": patient_id, "user": user.id,
        "code": body.reason_code, "text": reason_text, "hours": GRANT_HOURS,
    })).one()
    reason = body.reason_code if reason_text is None else f"{body.reason_code}: {reason_text}"
    audit_detail(request, action="break-glass", reason=reason[:500])
    await events.publish(db, "break-glass.granted", f"patient/{patient_id}",
                         {"grantId": str(grant_id), "userId": str(user.id)},
                         patient_id=patient_id)
    await db.commit()
    return {"id": str(grant_id), "patientId": str(patient_id), "userId": str(user.id),
            "reasonCode": body.reason_code, "grantedAt": _time(granted.granted_at),
            "expiresAt": _time(granted.expires_at)}


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
