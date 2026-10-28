"""The outbox worker (T29, D25; app/integration/worker.py)."""

from pydantic import SecretStr
from pydantic_settings import BaseSettings


class OutboxFields(BaseSettings):
    integration_database_url: SecretStr | None = None  # shri_integration: partner worker
