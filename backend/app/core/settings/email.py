"""Email from the partner worker (app/integration/email.py; D25: email is a partner, Q15).

- **`BREVO_API_KEY`** comes from OpenBao KV only (secret/shri-health/api, read at startup by
  OpenBaoSource), never from an environment variable, a settings file or the repository: an
  environment variable of that name is ignored (OPENBAO_ONLY, settings/__init__.py). It is a
  SecretStr, so it never shows in a repr, a log line or an error.
- **`EMAIL_TEAM_ALLOWLIST`**: the team's own addresses, comma-separated. Only these go out through
  Brevo; every other address goes to Mailpit. Empty (CI, development): everything goes to Mailpit.
- **`MAILPIT_SMTP_HOST`** (and port): the demo mail catcher (infra/deploy, demo hosts only).
  Empty: there is nowhere to catch mail, and a message for anyone off the allowlist dead-letters.
- **Never in production** (settings refuse it): Brevo's free plan signs no BAA, so production
  waits for a provider that does (Q15), as configuration only.
"""

from pydantic import SecretStr
from pydantic_settings import BaseSettings

# Settings read only from OpenBao: an environment variable with this name is dropped.
OPENBAO_ONLY = frozenset({"brevo_api_key"})


class EmailFields(BaseSettings):
    brevo_api_key: SecretStr | None = None
    email_team_allowlist: str = ""
    email_from_address: str = ""
    email_from_name: str = "Shri Health"
    mailpit_smtp_host: str = ""
    mailpit_smtp_port: int = 1025

    def team_addresses(self) -> frozenset[str]:
        """The allowlist, lower-cased; blanks dropped."""
        return frozenset(a.strip().lower() for a in self.email_team_allowlist.split(",")
                         if a.strip())
