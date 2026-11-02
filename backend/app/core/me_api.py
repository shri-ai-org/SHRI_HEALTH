"""GET /me (contract operation getMe, x-owner thulasi): the signed-in user, their clinic, their
effective permissions and the practice settings every screen needs (D39).

The permissions come from core's ROLE_PERMISSIONS for the user's roles today, so menus match
what require() will allow; the server still checks every action. Audit `none`.
"""

from typing import Any

from fastapi import APIRouter, Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.config import Settings
from app.core.deps import CurrentUser, require, tenant_db
from app.core.routing import API_PREFIX

router = APIRouter(tags=["platform"])

_CLINIC = text("SELECT name FROM admin.tenant WHERE id = :id")
# The practice's value, or the platform default when the practice never set it (D39: off).
_SETTING = text(
    "SELECT COALESCE((SELECT value FROM admin.tenant_setting WHERE setting_key = :key), "
    "(SELECT default_value FROM admin.setting_definition WHERE key = :key))")
_SHOW_SOGI = "registration.show_sogi_fields"


@router.get("/me", operation_id="getMe")
async def get_me(user: CurrentUser = Depends(require("authenticated")),
                 db: AsyncSession = Depends(tenant_db)) -> dict[str, Any]:
    clinic = (await db.execute(_CLINIC, {"id": user.organization_id})).scalar_one_or_none()
    show_sogi = (await db.execute(_SETTING, {"key": _SHOW_SOGI})).scalar_one_or_none()
    return {
        "user": {"id": str(user.id), "displayName": user.display_name,
                 "roles": sorted(user.roles),
                 "facilityIds": sorted(str(f) for f in user.facility_ids)},
        "organization": {"id": str(user.organization_id), "name": clinic or ""},
        "permissions": sorted(permissions.permissions_of(user.roles)),
        "practiceSettings": {
            "registration": {"showSexualOrientationAndGenderIdentity": show_sogi == "true"}},
    }


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
