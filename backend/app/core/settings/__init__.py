"""Settings, loaded from environment variables and (optionally) OpenBao, one module per area:

    base         environment, database roles, error links, the build stamp
    auth         staff sign-in (Keycloak, sessions, CSRF)
    portal       the patient portal
    openbao      secrets at startup (KV) and field encryption (Transit)
    public_form  the public pre-registration form and its bot check
    outbox       the partner worker and partner callbacks
    events       live events
    files        the file service
    ai           the Claude API key (from OpenBao)
    email        the partner worker's email: Brevo's key (OpenBao only), the team allowlist, Mailpit

They combine into one Settings object with the same environment variable names, defaults and
validation as before the split; `app.core.config` re-exports it, so imports don't change.

Priority, highest first: values passed to Settings(...), environment variables, OpenBao KV
secrets, defaults. Secrets never live in source control. A few secrets are read from OpenBao only
(email.OPENBAO_ONLY): an environment variable with their name is ignored.
"""

from functools import lru_cache
from typing import Any

import httpx
from pydantic import SecretStr, model_validator
from pydantic.fields import FieldInfo
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

from app.core.settings.ai import AiFields
from app.core.settings.auth import AuthFields, AuthMode
from app.core.settings.base import BaseFields, Environment
from app.core.settings.email import OPENBAO_ONLY, EmailFields
from app.core.settings.events import EventsFields
from app.core.settings.files import OBJECT_STORE_FIELDS, FilesFields
from app.core.settings.openbao import OpenBaoFields
from app.core.settings.outbox import OutboxFields
from app.core.settings.portal import PortalFields
from app.core.settings.public_form import PublicFormFields

__all__ = ["AuthMode", "Environment", "OpenBaoSource", "Settings", "get_settings"]


class Settings(BaseFields, AuthFields, PortalFields, OpenBaoFields, PublicFormFields,
               OutboxFields, EventsFields, FilesFields, AiFields, EmailFields):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", case_sensitive=False)

    @model_validator(mode="after")
    def _dev_auth_only_in_dev(self) -> "Settings":
        if self.auth_mode == "dev_header" and self.environment not in ("development", "test"):
            raise ValueError("auth_mode=dev_header is only allowed in development and test")
        if (self.patient_auth_mode == "dev_header"
                and self.environment not in ("development", "test")):
            raise ValueError(
                "patient_auth_mode=dev_header is only allowed in development and test")
        return self

    @model_validator(mode="after")
    def _simulated_partners_never_in_production(self) -> "Settings":
        if self.simulated_partners and self.environment == "production":
            raise ValueError("simulated_partners is never allowed in production")
        if self.simulated_partners and not self.simulated_partner_callback_url:
            raise ValueError("simulated_partners needs SIMULATED_PARTNER_CALLBACK_URL")
        for name in ("hook_secret_clearinghouse", "hook_secret_erx"):
            secret = getattr(self, name)
            if secret is not None and len(secret.get_secret_value()) < 32:
                raise ValueError(f"{name.upper()} must be at least 32 characters")
        return self

    @model_validator(mode="after")
    def _demo_sign_in_only_on_a_demo_server(self) -> "Settings":
        # D121: the mobile + date-of-birth sign-in opens a chart without a password, so it runs
        # only on a demo server with synthetic patients, never in production.
        if self.portal_demo_sign_in and self.environment == "production":
            raise ValueError("portal_demo_sign_in is never allowed in production (D121)")
        if self.portal_demo_sign_in and not self.shri_demo:
            raise ValueError("portal_demo_sign_in needs SHRI_DEMO=true (D121: demo servers only)")
        return self

    @model_validator(mode="after")
    def _email_routes_never_in_production(self) -> "Settings":
        # Brevo's free plan signs no BAA and Mailpit is the demo's mail catcher: production
        # sends no email until a provider that signs one is chosen (Q15).
        if self.environment == "production" and (self.team_addresses() or self.mailpit_smtp_host):
            raise ValueError("EMAIL_TEAM_ALLOWLIST and MAILPIT_SMTP_HOST are never allowed in "
                             "production (no BAA; Q15)")
        if self.team_addresses() and not self.email_from_address:
            raise ValueError("EMAIL_TEAM_ALLOWLIST needs EMAIL_FROM_ADDRESS")
        if not 0 < self.mailpit_smtp_port < 65536:
            raise ValueError("MAILPIT_SMTP_PORT is a port number")
        return self

    @model_validator(mode="after")
    def _object_store_complete(self) -> "Settings":
        missing = self.missing(*OBJECT_STORE_FIELDS)
        if missing and len(missing) < len(OBJECT_STORE_FIELDS):
            raise ValueError(f"The file store is not configured: set {', '.join(missing)}")
        return self

    def missing(self, *fields: str) -> list[str]:
        """The environment variables of `fields` that are unset or empty, for startup errors
        that name what to set (never their values)."""
        absent = []
        for field in fields:
            value = getattr(self, field)
            if isinstance(value, SecretStr):
                value = value.get_secret_value()
            if not value:
                absent.append(field.upper())
        return absent

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (init_settings, _WithoutOpenBaoOnly(settings_cls, env_settings),
                OpenBaoSource(settings_cls, env_settings))


class _WithoutOpenBaoOnly(PydanticBaseSettingsSource):
    """The environment, minus the settings read from OpenBao only (email.OPENBAO_ONLY), so a
    BREVO_API_KEY in deploy.env or the shell can never stand in for the one in OpenBao."""

    def __init__(self, settings_cls: type[BaseSettings], env: PydanticBaseSettingsSource):
        super().__init__(settings_cls)
        self._env = env

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        return None, field_name, False  # unused: __call__ filters the whole source

    def __call__(self) -> dict[str, Any]:
        return {k: v for k, v in self._env().items() if k.lower() not in OPENBAO_ONLY}


class OpenBaoSource(PydanticBaseSettingsSource):
    """Reads one KV v2 secret from OpenBao; its keys map to setting names (case-insensitive).

    If OpenBao is configured but cannot be read, startup fails rather than running
    with missing secrets.
    """

    def __init__(self, settings_cls: type[BaseSettings], env: PydanticBaseSettingsSource):
        super().__init__(settings_cls)
        self._env = env

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        # Unused: __call__ loads the whole secret at once.
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        env = self._env()
        addr = env.get("openbao_addr")
        if not addr:
            return {}
        token = env.get("openbao_token")
        if not token:
            raise RuntimeError("OPENBAO_ADDR is set but OPENBAO_TOKEN is missing")
        mount = env.get("openbao_kv_mount", "secret")
        path = env.get("openbao_secret_path", "shri-health/api")
        url = f"{addr.rstrip('/')}/v1/{mount}/data/{path}"
        try:
            response = httpx.get(url, headers={"X-Vault-Token": str(token)}, timeout=5.0)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Could not read settings from OpenBao at {mount}/{path}") from exc
        data: dict[str, Any] = response.json()["data"]["data"]
        fields = self.settings_cls.model_fields
        return {key.lower(): value for key, value in data.items() if key.lower() in fields}


@lru_cache
def get_settings() -> Settings:
    return Settings()
