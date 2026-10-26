"""New rows inherit the session's clinic, so building a resource with child rows (names,
identifiers, components ...) does not repeat ``tenant_id`` on every object.

This module owns no engine and no session. The API's sessions come from the core's
``tenant_db`` (``backend/app/core/deps.py``, D21), which sets the three settings the schema's
row-level security reads; ``/fhir`` gets its session from the ``fhir_db`` seam in
``backend/app/fhir/api.py``. Row-level security still checks every row this hook fills in.

The hook reads ``session.info["tenant_id"]``, the clinic UUID. The core's ``tenant_session()``
sets it (PR #28, ``app.core.db.TENANT_ID_INFO_KEY``); sessions without a clinic don't have the
key, and the hook then does nothing. ``AsyncSession.info`` is the sync session's ``info`` dict,
so ``before_flush`` sees it. The schema tests set the key themselves.

Rule: fill ``tenant_id`` only where it is empty; never overwrite one. A row explicitly given
another clinic keeps it, and forced RLS then refuses the insert.
"""

from typing import Any

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.db import TENANT_ID_INFO_KEY


@event.listens_for(Session, "before_flush")
def _default_tenant(session: Session, flush_context: Any, instances: Any) -> None:
    tenant = session.info.get(TENANT_ID_INFO_KEY)
    if tenant is None:
        return
    for obj in session.new:
        if getattr(obj, "tenant_id", False) is None:
            table = getattr(type(obj), "__table__", None)
            if table is not None and not table.c.tenant_id.nullable:
                obj.tenant_id = tenant
