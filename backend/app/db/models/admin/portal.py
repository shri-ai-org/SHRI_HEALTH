"""The patient portal's sign-in tables (ADR-0013 §3 and §5, D92; migration 0011), and the
back-channel logout's used tokens (D94).

None of them holds a secret in clear text: an invitation code is stored only as its HMAC, a
session token only as its SHA-256 hash, and Keycloak's tokens only encrypted. Three steps
happen before a clinic is known, and each has its own narrow SECURITY DEFINER function, EXECUTE
for ``shri_app`` only: ``admin.lookup_portal_session``, ``admin.lookup_portal_account`` and
``admin.redeem_portal_invitation``. A staff session lookup never returns a portal session, and
the reverse. Rows leave only through ``admin.purge_expired_runtime_rows()``.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, SmallInteger, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import ADMIN_SCHEMA, AdminMixin, Base, UUIDPKMixin, enum_type
from app.db.models.admin.runtime import CIPHERTEXT, SHA256_HEX
from app.db.models.enums import PortalAccountStatus

#: Failed redemptions after which an invitation is revoked (ADR-0013 §3).
MAX_INVITATION_TRIES = 5


class PortalInvitation(Base, AdminMixin):
    """An enrolment code the front desk issued in person, after an ID check (ADR-0013 §3).
    Only the code's HMAC (with a key from OpenBao) is stored. 72 hours, single use, and one open
    invitation per patient: issuing a new one revokes the old one in the same transaction."""
    __tablename__ = "portal_invitation"
    __table_args__ = (
        Index("uq_portal_invitation_code_hmac", "code_hmac", unique=True),
        Index("uq_portal_invitation_one_open", "patient_id", unique=True,
              postgresql_where=text("used_at IS NULL AND revoked_at IS NULL")),
        CheckConstraint(f"code_hmac {SHA256_HEX}", name="code_hmac_format"),
        CheckConstraint("expires_at > created_at", name="expires_after_issue"),
        CheckConstraint(f"failed_tries BETWEEN 0 AND {MAX_INVITATION_TRIES}",
                        name="failed_tries_range"),
        CheckConstraint("used_at IS NULL OR revoked_at IS NULL", name="used_or_revoked"),
    )

    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"),
                                                  nullable=False)
    code_hmac: Mapped[str] = mapped_column(String(64), nullable=False)
    issued_by_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey(f"{ADMIN_SCHEMA}.app_user.id"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)
    used_at: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]
    failed_tries: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0,
                                              server_default=text("0"))


class PortalAccount(Base, AdminMixin):
    """The link from a patient-realm Keycloak user to one chart (ADR-0013 §5; one account, one
    chart in P1, D85). Disabling (D92) needs its time and reason; a merge suspends the account
    (ADR-0013 §6) and keeps the status it had, which the undo restores. A disabled account is
    never suspended or re-activated by a merge."""
    __tablename__ = "portal_account"
    __table_args__ = (
        Index("uq_portal_account_keycloak_user_id", "keycloak_user_id", unique=True),
        Index("uq_portal_account_patient", "tenant_id", "patient_id", unique=True),
        CheckConstraint("(status = 'disabled') = (disabled_at IS NOT NULL AND "
                        "coalesce(length(trim(disabled_reason)), 0) > 0)",
                        name="disabled_has_time_and_reason"),
        CheckConstraint("(status = 'suspended') = (status_before_suspension IS NOT NULL "
                        "AND suspended_by_merge_id IS NOT NULL)", name="suspended_has_origin"),
        CheckConstraint("status_before_suspension IS NULL OR "
                        "status_before_suspension IN ('pending-setup', 'active')",
                        name="suspended_from_live"),
        CheckConstraint("status = 'pending-setup' OR enrolled_at IS NOT NULL",
                        name="set_up_has_time"),
    )

    keycloak_user_id: Mapped[str] = mapped_column(String(100), nullable=False)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"),
                                                  nullable=False)
    status: Mapped[PortalAccountStatus] = mapped_column(
        enum_type(PortalAccountStatus), nullable=False,
        default=PortalAccountStatus.PENDING_SETUP.value,
        server_default=PortalAccountStatus.PENDING_SETUP.value)
    #: When the patient finished the realm's set-up (first sign-in).
    enrolled_at: Mapped[datetime | None]
    factors_reset_at: Mapped[datetime | None]
    disabled_at: Mapped[datetime | None]
    disabled_reason: Mapped[str | None] = mapped_column(String(500))
    status_before_suspension: Mapped[PortalAccountStatus | None] = mapped_column(
        enum_type(PortalAccountStatus))
    suspended_by_merge_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(f"{ADMIN_SCHEMA}.patient_merge.id"))


class PortalSession(Base, AdminMixin):
    """A patient's server-side session (ADR-0013 §5): the app_session columns, for the account
    and its patient instead of a user. ``__Host-shri_portal`` carries the token, stored only as
    a SHA-256 hash. 15 minutes idle and 4 hours absolute (Q20), set by core."""
    __tablename__ = "portal_session"
    __table_args__ = (
        Index("uq_portal_session_token_hash", "token_hash", unique=True),
        Index("ix_portal_session_account", "tenant_id", "account_id"),
        Index("ix_portal_session_expires", "expires_at"),
        CheckConstraint(f"token_hash {SHA256_HEX}", name="token_hash_format"),
        CheckConstraint("idle_expires_at <= expires_at", name="idle_within_absolute"),
        CheckConstraint(f"keycloak_access_token_enc {CIPHERTEXT} AND "
                        f"keycloak_refresh_token_enc {CIPHERTEXT}", name="tokens_encrypted"),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{ADMIN_SCHEMA}.portal_account.id"),
                                                  nullable=False)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clinical.patient.id"),
                                                  nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    keycloak_access_token_enc: Mapped[str] = mapped_column(Text, nullable=False)
    keycloak_refresh_token_enc: Mapped[str] = mapped_column(Text, nullable=False)
    keycloak_sid: Mapped[str | None] = mapped_column(String(100))
    last_activity_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
    tokens_refreshed_at: Mapped[datetime] = mapped_column(nullable=False,
                                                          server_default=func.now())
    idle_expires_at: Mapped[datetime] = mapped_column(nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)
    revoked_at: Mapped[datetime | None]


class ConsumedLogoutToken(Base, UUIDPKMixin):
    """A staff back-channel logout token already acted on (D94; OpenID Connect Back-Channel
    Logout 1.0: ``jti`` used once). Platform-wide, since the token arrives before any clinic is
    known; no role reads or writes it except ``admin.end_backchannel_sessions()``. Kept until
    the token itself expires."""
    __tablename__ = "consumed_logout_token"
    __table_args__ = (
        Index("uq_consumed_logout_token_jti", "jti", unique=True),
        Index("ix_consumed_logout_token_expires", "expires_at"),
        CheckConstraint("length(jti) BETWEEN 1 AND 255", name="jti_given"),
    )

    jti: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)
    consumed_at: Mapped[datetime] = mapped_column(nullable=False, server_default=func.now())
