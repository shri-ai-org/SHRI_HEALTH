"""OpenBao: secrets at startup (KV v2) and field encryption (Transit)."""

from pydantic import SecretStr
from pydantic_settings import BaseSettings


class OpenBaoFields(BaseSettings):
    # OpenBao (KV v2). When openbao_addr is set, secrets are read from
    # {openbao_addr}/v1/{openbao_kv_mount}/data/{openbao_secret_path} at startup.
    openbao_addr: str | None = None
    openbao_token: SecretStr | None = None
    openbao_kv_mount: str = "secret"
    openbao_secret_path: str = "shri-health/api"  # noqa: S105 (a path, not a secret)

    # OpenBao Transit, for field encryption (core/crypto.py). The token is the API's narrow one:
    # encrypt and decrypt with openbao_transit_key only, never a root token. Unset: anything that
    # needs encryption fails with a 500 (fail closed).
    openbao_transit_addr: str | None = None
    openbao_transit_token: SecretStr | None = None
    openbao_transit_mount: str = "transit"
    openbao_transit_key: str = "shri-fields"
    # The files' key-encryption key (envelope encryption, crypto.new_data_key): the token may make
    # data keys with it and unwrap them, nothing else.
    openbao_transit_files_key: str = "shri-files"
