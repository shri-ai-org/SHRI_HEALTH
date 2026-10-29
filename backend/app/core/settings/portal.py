"""The patient portal (ADR-0013): patient sign-in through the shri-patients realm, enrolment by
invitation code, and the portal's own database role."""

from pydantic import SecretStr
from pydantic_settings import BaseSettings

from app.core.settings.auth import AuthMode


class PortalFields(BaseSettings):
    # The patient portal's sign-in. "dev_header" is the development stand-in (X-Dev-Patient and
    # X-Dev-Patient-Clinic headers), refused outside development and test like auth_mode's, so
    # screens and portal reads can be built before patient sign-in exists (ADR-0013, T45).
    patient_auth_mode: AuthMode = "keycloak"

    # The patient realm, on the same Keycloak as staff (keycloak_public_url, keycloak_internal_url)
    # but its own realm, client and cookie (ADR-0013 §1).
    portal_keycloak_realm: str = "shri-patients"
    portal_client_id: str = "shri-portal-web"
    portal_client_secret: SecretStr | None = None
    portal_redirect_uri: str | None = None  # https://<portal host>/api/v1/portal/auth/callback
    portal_after_login_path: str = "/portal/"
    # The API's service account in the patient realm: manage-users and view-users only, for
    # enrolment, the factor reset and disabling an account (§1, §3).
    portal_admin_client_id: str = "shri-portal-admin"
    portal_admin_client_secret: SecretStr | None = None

    # Keys: the portal session's CSRF token, and the invitation code's HMAC (never the code
    # itself is stored). At least 32 characters each; from OpenBao outside development.
    portal_session_secret: SecretStr | None = None
    portal_invitation_secret: SecretStr | None = None

    # Portal requests read and write as shri_portal (D93), never shri_app.
    portal_database_url: SecretStr | None = None

    # Idle 15 minutes, absolute 4 hours (ADR-0013 §5; Q20).
    portal_idle_minutes: int = 15
    portal_absolute_hours: int = 4
    # Enrolment attempts per client IP per 10 minutes, before the 429 (and nginx's own limit).
    portal_enrollment_ip_limit: int = 10
