"""Patients and insurance API (batch 1, contracts/openapi/modules/patients.yaml). Routes are added
PR by PR, following contracts/docs/IMPL_BATCH1_PLAN.md; each route's operation_id is the
contract's operationId.
"""

from fastapi import APIRouter

router = APIRouter(tags=["patients"])
