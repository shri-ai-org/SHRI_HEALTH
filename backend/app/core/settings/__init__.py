"""Settings, loaded from environment variables and (optionally) OpenBao, one module per area:

    base         environment, database roles, error links, the build stamp
    auth         staff sign-in (Keycloak, sessions, CSRF)
    portal       the patient portal
    openbao      secrets at startup (KV) and field encryption (Transit)
    public_form  the public pre-registration form and its bot check
    outbox       the partner worker
    events       live events
    files        the file service

They combine into one Settings object with the same environment variable names, defaults and
validation as before the split; `app.core.config` re-exports it, so imports don't change.

Priority, highest first: values passed to Settings(...), environment variables, OpenBao KV
secrets, defaults. Secrets never live in source control.
"""

from functools import lru_cache
from typing import Any

import httpx
from pydantic import SecretStr, model_validator
from pydantic.fields import FieldInfo
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

from app.core.settings.auth import AuthFields, AuthMode
from app.core.settings.base import BaseFields, Environment
from app.core.settings.events import EventsFields
from app.core.settings.files import FilesFields
from app.core.settings.openbao import OpenBaoFields
from app.core.settings.outbox import OutboxFields
from app.core.settings.portal import PortalFields
from app.core.settings.public_form import PublicFormFields

__all__ = ["AuthMode", "Environment", "OpenBaoSource", "Settings", "get_settings"]


class Settings(BaseFields, AuthFields, PortalFields, OpenBaoFields, PublicFormFields,
               OutboxFields, EventsFields, FilesFields):
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
        return (init_settings, env_settings, OpenBaoSource(settings_cls, env_settings))


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
