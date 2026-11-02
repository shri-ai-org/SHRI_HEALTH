"""The outbox worker (T29, D25; app/integration/worker.py) and partner callbacks (/hooks/*)."""

from pydantic import SecretStr
from pydantic_settings import BaseSettings


class OutboxFields(BaseSettings):
    integration_database_url: SecretStr | None = None  # shri_integration: partner worker

    # Partner callbacks (API_STANDARDS §16.1; core/partner_hooks.py): one signing secret per
    # partner, at least 32 characters. Unset, that partner's /hooks route answers 503.
    hook_secret_clearinghouse: SecretStr | None = None
    hook_secret_erx: SecretStr | None = None

    # The simulated payer and pharmacy for the demo (app/integration/simulated.py): the worker
    # answers clearinghouse and erx messages itself and posts the signed reply to
    # {simulated_partner_callback_url}/hooks/<partner>. Never in production.
    simulated_partners: bool = False
    simulated_partner_callback_url: str | None = None
