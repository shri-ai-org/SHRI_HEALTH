"""Public forms (D96; core/public_form.py): online pre-registration and its bot check."""

from pydantic import SecretStr
from pydantic_settings import BaseSettings


class PublicFormFields(BaseSettings):
    # shri_public: the public pre-registration form only (D96). The role has no table privileges;
    # it can only run admin.submit_pre_registration(). Unset: public forms answer 503.
    public_database_url: SecretStr | None = None

    # portal_origin is the only `Origin` public forms accept, exactly (scheme, host and port),
    # e.g. "https://portal.example.org". public_form_secret keys the email rate limit's hash and
    # signs the bot-check challenges; at least 32 characters, from OpenBao or the environment,
    # never in code. Either unset: public forms answer 503.
    portal_origin: str | None = None
    public_form_secret: SecretStr | None = None
    public_form_ip_limit: int = 20  # requests per IP per window
    public_form_ip_window_seconds: int = 3600
    bot_challenge_ip_limit: int = 60  # GET /portal/bot-challenge, per IP per hour (its own budget)
    public_form_email_limit: int = 5  # requests per email address (as its keyed hash) per window
    public_form_email_window_seconds: int = 86400
    bot_check_max_number: int = 100_000  # the proof of work: about a second on a slow phone
    bot_check_ttl_seconds: int = 600  # a challenge expires after this
