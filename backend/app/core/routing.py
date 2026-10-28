"""One router per module folder, found automatically.

A module joins the API by adding `backend/app/modules/<name>/api.py` that defines
`router = APIRouter(...)`. Nobody edits a central list, so owners never touch each
other's files to register routes. A module whose api.py fails to import stops startup.
"""

import importlib
import logging
from pathlib import Path

from fastapi import APIRouter, FastAPI

import app.modules
from app.core.config import Settings

API_PREFIX = "/api/v1"


def module_names() -> list[str]:
    root = Path(next(iter(app.modules.__path__)))
    return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / "api.py").is_file())


def include_module_routers(application: FastAPI) -> list[str]:
    included = []
    for name in module_names():
        module = importlib.import_module(f"app.modules.{name}.api")
        router = getattr(module, "router", None)
        if not isinstance(router, APIRouter):
            raise RuntimeError(f"app/modules/{name}/api.py must define `router = APIRouter(...)`")
        application.include_router(router, prefix=API_PREFIX)
        included.append(name)
    return included


def register(application: FastAPI, settings: Settings) -> None:
    """Every module's router, found by folder (module_names)."""
    modules = include_module_routers(application)
    logging.getLogger("app.main").info("Modules with routes: %s", ", ".join(modules) or "none")
