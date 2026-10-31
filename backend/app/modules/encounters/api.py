"""Encounters and notes API (batch 2, contracts/openapi/modules/encounters.yaml). Batch 1 only uses
this module's service (check-in creates the encounter, D16); its routes come with batch 2.
B8a: the patient portal's visit summaries (portal_api.py).
"""

from fastapi import APIRouter

from .portal_api import router as _portal_router

router = APIRouter(tags=["encounters"])
router.include_router(_portal_router)
