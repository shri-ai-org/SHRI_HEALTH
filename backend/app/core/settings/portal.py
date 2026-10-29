"""The patient portal (ADR-0013)."""

from pydantic_settings import BaseSettings

from app.core.settings.auth import AuthMode


class PortalFields(BaseSettings):
    # The patient portal's sign-in. "dev_header" is the development stand-in (X-Dev-Patient and
    # X-Dev-Patient-Clinic headers), refused outside development and test like auth_mode's, so
    # screens and portal reads can be built before patient sign-in exists (ADR-0013, T45).
    patient_auth_mode: AuthMode = "keycloak"
