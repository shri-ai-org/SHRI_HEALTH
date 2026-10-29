"""The object store (SeaweedFS's S3 API): AWS Signature Version 4, with the standard library only.

The runtime lock has no S3 library, so this signs requests itself (``hmac``, ``hashlib``) and
sends them with ``httpx``. Two ways to sign, both SigV4 (AWS's "Signature Version 4 signing
process" for S3):

- **pre-signed links** (``presign()``): the signature is in the query string and the payload is
  ``UNSIGNED-PAYLOAD``, so a browser can ``PUT`` an upload into quarantine or ``GET`` a clean
  file directly, without the bytes passing through the API (API_STANDARDS §15);
- **the API's own requests** (``sign_headers()``): the signature is in ``Authorization`` and the
  payload's SHA-256 is signed, for ``S3FileStore.put``, ``get`` and ``delete``.

``S3FileStore`` uses path-style URLs (``<endpoint>/<bucket>/<key>``), which SeaweedFS serves.

TEMPORARY SEAM: configured by environment variables until core has settings for the object
store (asked of Thulasi on #13; SeaweedFS on the dev backend Thu 5 Nov):

    SHRI_S3_ENDPOINT              where the API reaches the store, e.g. http://seaweedfs:8333
    SHRI_S3_PUBLIC_ENDPOINT       where browsers reach it, for links (default: the endpoint)
    SHRI_S3_REGION                default us-east-1
    SHRI_S3_ACCESS_KEY_ID         the API's key, never a root key
    SHRI_S3_SECRET_ACCESS_KEY
    SHRI_S3_BUCKET_CLEAN          the real bucket names behind the logical ``clean`` and
    SHRI_S3_BUCKET_QUARANTINE     ``quarantine`` (admin.binary_object.bucket keeps the logical one)

When core's settings land, ``S3Config.from_env`` is replaced by reading them; nothing else here
changes. The secret key and every signed URL are secrets: never logged, never in a repr.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlsplit

import httpx

from app.core.errors import ServiceUnavailable

from .storage import CLEAN_BUCKET, QUARANTINE_BUCKET, SignedLink, check_key

log = logging.getLogger(__name__)

ALGORITHM = "AWS4-HMAC-SHA256"
SERVICE = "s3"
UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
MAX_EXPIRES = timedelta(days=7)  # SigV4's limit for a pre-signed link
TIMEOUT_SECONDS = 30.0
_UNRESERVED = "-_.~"  # with letters and digits, never encoded (quote() keeps those)


def uri_encode(value: str, *, keep_slash: bool = False) -> str:
    """SigV4's UriEncode: every byte but A-Z a-z 0-9 - _ . ~ percent-encoded, upper-case hex;
    ``/`` kept only in a path."""
    return quote(value, safe=_UNRESERVED + ("/" if keep_slash else ""))


def canonical_query(params: Mapping[str, str]) -> str:
    encoded = sorted((uri_encode(k), uri_encode(v)) for k, v in params.items())
    return "&".join(f"{k}={v}" for k, v in encoded)


def canonical_request(method: str, path: str, query: Mapping[str, str],
                      headers: Mapping[str, str], payload_hash: str) -> tuple[str, str]:
    """The canonical request and its signed-header list. Every header given is signed."""
    lowered = sorted((name.lower().strip(), " ".join(value.split()))
                     for name, value in headers.items())
    signed = ";".join(name for name, _ in lowered)
    request = "\n".join([
        method, uri_encode(path, keep_slash=True), canonical_query(query),
        "".join(f"{name}:{value}\n" for name, value in lowered), signed, payload_hash])
    return request, signed


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret_key: str, date: str, region: str, service: str = SERVICE) -> bytes:
    k_date = _hmac(f"AWS4{secret_key}".encode(), date)
    return _hmac(_hmac(_hmac(k_date, region), service), "aws4_request")


def scope(when: datetime, region: str, service: str = SERVICE) -> str:
    return f"{when:%Y%m%d}/{region}/{service}/aws4_request"


def string_to_sign(when: datetime, region: str, request: str) -> str:
    return "\n".join([ALGORITHM, f"{when:%Y%m%dT%H%M%SZ}", scope(when, region),
                      hashlib.sha256(request.encode("utf-8")).hexdigest()])


def signature(secret_key: str, when: datetime, region: str, request: str) -> str:
    key = signing_key(secret_key, f"{when:%Y%m%d}", region)
    return hmac.new(key, string_to_sign(when, region, request).encode("utf-8"),
                    hashlib.sha256).hexdigest()


def presign(method: str, host: str, path: str, *, access_key: str, secret_key: str,
            region: str, when: datetime, expires: timedelta,
            headers: Mapping[str, str] | None = None,
            query: Mapping[str, str] | None = None) -> str:
    """The signed query string (``…&X-Amz-Signature=…``) for ``method`` on ``host`` + ``path``.

    ``host`` is always signed; ``headers`` are signed too, so the browser must send exactly
    those (the upload's ``Content-Type``). ``query`` adds parameters, such as
    ``response-content-disposition``, which are signed with the rest.
    """
    if not timedelta(seconds=1) <= expires <= MAX_EXPIRES:
        raise ValueError("A pre-signed link lasts between 1 second and 7 days")
    signed_headers = {"host": host, **(headers or {})}
    params = {
        **(query or {}),
        "X-Amz-Algorithm": ALGORITHM,
        "X-Amz-Credential": f"{access_key}/{scope(when, region)}",
        "X-Amz-Date": f"{when:%Y%m%dT%H%M%SZ}",
        "X-Amz-Expires": str(int(expires.total_seconds())),
        "X-Amz-SignedHeaders": ";".join(sorted(h.lower() for h in signed_headers)),
    }
    request, _ = canonical_request(method, path, params, signed_headers, UNSIGNED_PAYLOAD)
    params["X-Amz-Signature"] = signature(secret_key, when, region, request)
    return canonical_query(params)


def sign_headers(method: str, host: str, path: str, *, access_key: str, secret_key: str,
                 region: str, when: datetime, payload: bytes = b"",
                 headers: Mapping[str, str] | None = None) -> dict[str, str]:
    """The headers of a signed request: ``x-amz-date``, ``x-amz-content-sha256`` (the
    payload's SHA-256), the given ones and ``Authorization``. ``host`` is signed, not returned
    (the HTTP client sends it)."""
    payload_hash = hashlib.sha256(payload).hexdigest()
    signed_headers = {"host": host, "x-amz-content-sha256": payload_hash,
                      "x-amz-date": f"{when:%Y%m%dT%H%M%SZ}", **(headers or {})}
    request, signed = canonical_request(method, path, {}, signed_headers, payload_hash)
    authorization = (f"{ALGORITHM} Credential={access_key}/{scope(when, region)}, "
                     f"SignedHeaders={signed}, "
                     f"Signature={signature(secret_key, when, region, request)}")
    return {**{k: v for k, v in signed_headers.items() if k != "host"},
            "Authorization": authorization}


@dataclass(frozen=True)
class S3Config:
    endpoint: str
    public_endpoint: str
    region: str
    access_key: str
    secret_key: str = field(repr=False)
    buckets: Mapping[str, str]  # logical (clean, quarantine) -> the store's bucket

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> S3Config | None:
        """From the ``SHRI_S3_*`` variables (module docstring); None when no endpoint is set.
        An endpoint with any other variable missing is a configuration error (fail closed)."""
        env = os.environ if env is None else env
        endpoint = env.get("SHRI_S3_ENDPOINT")
        if not endpoint:
            return None
        names = ("SHRI_S3_ACCESS_KEY_ID", "SHRI_S3_SECRET_ACCESS_KEY", "SHRI_S3_BUCKET_CLEAN",
                 "SHRI_S3_BUCKET_QUARANTINE")
        missing = [name for name in names if not env.get(name)]
        if missing:
            raise ServiceUnavailable("File storage is not fully configured")
        for url in (endpoint, env.get("SHRI_S3_PUBLIC_ENDPOINT") or endpoint):
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.netloc or parts.path.strip("/"):
                raise ServiceUnavailable("File storage endpoint must be a bare http(s) origin")
        return cls(endpoint=endpoint.rstrip("/"),
                   public_endpoint=(env.get("SHRI_S3_PUBLIC_ENDPOINT") or endpoint).rstrip("/"),
                   region=env.get("SHRI_S3_REGION") or "us-east-1",
                   access_key=env["SHRI_S3_ACCESS_KEY_ID"],
                   secret_key=env["SHRI_S3_SECRET_ACCESS_KEY"],
                   buckets={CLEAN_BUCKET: env["SHRI_S3_BUCKET_CLEAN"],
                            QUARANTINE_BUCKET: env["SHRI_S3_BUCKET_QUARANTINE"]})


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


class S3FileStore:
    """A ``FileStore`` on an S3 API (SeaweedFS), path-style. Store errors (unreachable, refused,
    an unexpected answer) are ``503 service-unavailable``; nothing about the request is logged
    but the method and the status."""

    def __init__(self, config: S3Config, *, transport: httpx.AsyncBaseTransport | None = None,
                 clock: Callable[[], datetime] = _now) -> None:
        self.config = config
        self._transport = transport
        self._clock = clock

    def _path(self, key: str, bucket: str) -> str:
        check_key(key, bucket)
        return f"/{self.config.buckets[bucket]}/{key}"

    async def _send(self, method: str, key: str, bucket: str, *, payload: bytes = b"",
                    headers: Mapping[str, str] | None = None) -> httpx.Response:
        path = self._path(key, bucket)
        url = f"{self.config.endpoint}{uri_encode(path, keep_slash=True)}"
        host = urlsplit(self.config.endpoint).netloc
        signed = sign_headers(method, host, path, access_key=self.config.access_key,
                              secret_key=self.config.secret_key, region=self.config.region,
                              when=self._clock(), payload=payload, headers=headers)
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS,
                                         transport=self._transport) as client:
                return await client.request(method, url, content=payload, headers=signed)
        except httpx.HTTPError as error:
            log.error("Object store unreachable on %s (%s)", method, type(error).__name__)
            raise ServiceUnavailable("File storage is unavailable") from None

    @staticmethod
    def _refused(method: str, response: httpx.Response) -> ServiceUnavailable:
        log.error("Object store refused %s (HTTP %s)", method, response.status_code)
        return ServiceUnavailable("File storage is unavailable")

    async def put(self, key: str, data: bytes, content_type: str, *,
                  bucket: str = CLEAN_BUCKET) -> None:
        # Keys are unique per file and written once; the HEAD keeps put()'s "never overwrite"
        # promise on stores without conditional writes.
        head = await self._send("HEAD", key, bucket)
        if head.status_code == 200:
            raise FileExistsError("Storage key already used")
        if head.status_code != 404:
            raise self._refused("HEAD", head)
        response = await self._send("PUT", key, bucket, payload=data,
                                    headers={"content-type": content_type})
        if response.status_code not in (200, 201, 204):
            raise self._refused("PUT", response)

    async def get(self, key: str, *, bucket: str = CLEAN_BUCKET) -> bytes:
        response = await self._send("GET", key, bucket)
        if response.status_code == 404:
            raise FileNotFoundError("No such stored file")
        if response.status_code != 200:
            raise self._refused("GET", response)
        return response.content

    async def delete(self, key: str, *, bucket: str = CLEAN_BUCKET) -> None:
        response = await self._send("DELETE", key, bucket)
        if response.status_code not in (200, 204, 404):
            raise self._refused("DELETE", response)

    def _link(self, method: str, key: str, bucket: str, expires: timedelta,
              headers: Mapping[str, str], query: Mapping[str, str]) -> SignedLink:
        path = self._path(key, bucket)
        when = self._clock()
        signed = presign(method, urlsplit(self.config.public_endpoint).netloc, path,
                         access_key=self.config.access_key, secret_key=self.config.secret_key,
                         region=self.config.region, when=when, expires=expires,
                         headers=headers, query=query)
        url = f"{self.config.public_endpoint}{uri_encode(path, keep_slash=True)}?{signed}"
        return SignedLink(url=url, expires_at=when + expires, headers=dict(headers))

    def presign_put(self, key: str, *, bucket: str, content_type: str, size_bytes: int,
                    expires: timedelta) -> SignedLink:
        # Content-Length is signed, so the store refuses a body of any other size: a browser
        # sets it itself from the body, so the client sends only the Content-Type.
        link = self._link("PUT", key, bucket, expires,
                          {"content-length": str(size_bytes), "content-type": content_type}, {})
        return SignedLink(url=link.url, expires_at=link.expires_at,
                          headers={"Content-Type": content_type})

    def presign_get(self, key: str, *, bucket: str, content_type: str,
                    expires: timedelta) -> SignedLink:
        # Always a download, never rendered at the store's origin; the type is the file's own.
        return self._link("GET", key, bucket, expires, {}, {
            "response-content-disposition": "attachment",
            "response-content-type": content_type})
