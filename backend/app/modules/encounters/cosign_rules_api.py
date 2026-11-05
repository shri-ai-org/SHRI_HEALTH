"""Co-signature rules (inventory #87-89, #251; encounters.yaml listCosignRules,
createCosignRule, getCosignRule, updateCosignRule). The permission (``require``) is the first
dependency. Practice settings with no patient data: core audits them as ``admin``."""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Response, status

from app.core.deps import CurrentUser, require

from . import cosign_rules_schemas as cs
from . import cosign_rules_service as cservice
from .api import DB
from .cosign_rules_repository import SqlCosignRuleRepository

router: APIRouter = APIRouter(tags=["encounters"])

RULES = "/cosign-rules"
RULE = RULES + "/{cosignRuleId}"


def cosign_rule_repository() -> SqlCosignRuleRepository:
    return SqlCosignRuleRepository()


CRepo = Annotated[SqlCosignRuleRepository, Depends(cosign_rule_repository)]
RuleId = Annotated[UUID, Path(alias="cosignRuleId")]


@router.get(RULES, operation_id="listCosignRules", response_model=cs.CosignRuleList,
            response_model_exclude_none=True)
async def list_cosign_rules(
    user: Annotated[CurrentUser, Depends(require("cosign-rules:read"))], db: DB, repo: CRepo,
    provider_id: Annotated[UUID | None, Query(alias="providerId")] = None,
    active_on: Annotated[date | None, Query(alias="activeOn")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> cs.CosignRuleList:
    items, next_cursor = await cservice.listed(db, repo, provider_id=provider_id,
                                               active_on=active_on, limit=limit, cursor=cursor)
    return cs.CosignRuleList(items=items, next_cursor=next_cursor)


@router.post(RULES, operation_id="createCosignRule", status_code=status.HTTP_201_CREATED,
             response_model=cs.CosignRule, response_model_exclude_none=True)
async def create_cosign_rule(
    user: Annotated[CurrentUser, Depends(require("cosign-rules:create"))],
    body: cs.CosignRuleCreate, response: Response, db: DB, repo: CRepo,
) -> cs.CosignRule:
    """Idempotency-Key is optional (x-idempotency: supported): core claims and replays it."""
    created, tag = await cservice.create(db, repo, user, body)
    response.headers["ETag"] = tag
    response.headers["Location"] = f"/api/v1{RULES}/{created.id}"
    return created


@router.get(RULE, operation_id="getCosignRule", response_model=cs.CosignRule,
            response_model_exclude_none=True)
async def get_cosign_rule(
    user: Annotated[CurrentUser, Depends(require("cosign-rules:read"))],
    rule_id: RuleId, response: Response, db: DB, repo: CRepo,
) -> cs.CosignRule:
    found, tag = await cservice.one(db, repo, rule_id)
    response.headers["ETag"] = tag
    return found


@router.patch(RULE, operation_id="updateCosignRule", response_model=cs.CosignRule,
              response_model_exclude_none=True)
async def update_cosign_rule(
    user: Annotated[CurrentUser, Depends(require("cosign-rules:update"))],
    rule_id: RuleId, body: cs.CosignRulePatch, response: Response, db: DB, repo: CRepo,
    if_match: Annotated[str | None, Header(alias="If-Match", max_length=128)] = None,
) -> cs.CosignRule:
    updated, tag = await cservice.update(db, repo, user, rule_id, body, if_match)
    response.headers["ETag"] = tag
    return updated
