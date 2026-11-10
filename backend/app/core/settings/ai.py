"""AI through the Claude API (Vimal, 10 Nov: no models on our own servers).

The key comes from OpenBao KV (`CLAUDE_API_KEY` at secret/shri-health/api, read at startup by
OpenBaoSource), never from a file in the repository. It is a SecretStr, so it never shows in a
repr, a log line or an error. Unset: the AI module treats the model as unavailable.
Fictional data only until there is a BAA with Anthropic.
"""

from pydantic import SecretStr
from pydantic_settings import BaseSettings


class AiFields(BaseSettings):
    claude_api_key: SecretStr | None = None
