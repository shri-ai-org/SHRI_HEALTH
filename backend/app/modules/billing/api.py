"""Billing API (contracts/openapi/modules/billing.yaml): recording a patient payment.

`recordPayment` (D58, D100, D104) records a copay or other payment and its receipt in one
transaction. The permission (`require`) is the first dependency, so a caller without it gets 401
or 403 before anything else is resolved. Core does the rest of what the contract asks around the
endpoint: `tenant_db` claims the required Idempotency-Key (x-idempotency) before the endpoint
runs and replays a finished one, and the audit row (x-audit, patient from the path) commits with
the payment. The endpoint has no idempotency or audit code of its own.

The receipt is sealed like every stored file (the file service's ``file_crypto``, AES-256-GCM
with core's data keys); without a data key the payment is refused (503) and nothing is stored.

`createCardSession` is not built: card payments wait for the card processor (Q17), so
`recordPayment` refuses `card` for now (service.py).
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, require, tenant_db
from app.modules.files.crypto import FileCrypto, file_crypto
from app.modules.files.storage import FileStore, file_store

from . import schemas, service
from .repository import PaymentRepository, SqlPaymentRepository

router = APIRouter(tags=["billing"])


def repository() -> PaymentRepository:
    return SqlPaymentRepository()


Repo = Annotated[PaymentRepository, Depends(repository)]
Store = Annotated[FileStore, Depends(file_store)]
Crypto = Annotated[FileCrypto, Depends(file_crypto)]
DB = Annotated[AsyncSession, Depends(tenant_db)]
PatientId = Annotated[UUID, Path(alias="patientId")]


@router.post("/patients/{patientId}/payments", operation_id="recordPayment",
             status_code=status.HTTP_201_CREATED, response_model=schemas.Payment,
             response_model_exclude_none=True)
async def record_payment(
    user: Annotated[CurrentUser, Depends(require("payments:create"))],
    patient_id: PatientId, body: schemas.PaymentCreate, response: Response, repo: Repo,
    store: Store, crypto: Crypto, db: DB,
) -> schemas.Payment:
    payment = await service.record_payment(db, repo, store, crypto, user, patient_id, body)
    response.headers["Location"] = service.location(patient_id, payment.id)
    response.headers["ETag"] = service.etag()
    return payment
