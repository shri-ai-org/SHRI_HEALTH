"""Encounters and notes API (batch 2, contracts/openapi/modules/encounters.yaml). Batch 1 only uses
this module's service (check-in creates the encounter, D16); its routes come with batch 2.
"""

from fastapi import APIRouter

router = APIRouter(tags=["encounters"])
