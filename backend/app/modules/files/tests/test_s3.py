"""The SigV4 signer against AWS's published Signature Version 4 examples for S3, and the store's
requests against a fake S3 server (httpx.MockTransport). No network.

The three vectors are the examples in AWS's S3 API reference ("Signature Calculations for the
Authorization Header: Transferring Payload in a Single Chunk", GET Object and PUT Object, and
"Authenticating Requests: Using Query Parameters"), with AWS's example credentials (not a real
key). Synthetic data only.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest

from app.core.errors import ServiceUnavailable

from .. import s3
from ..storage import CLEAN_BUCKET, QUARANTINE_BUCKET

AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
AWS_TIME = datetime(2013, 5, 24, tzinfo=UTC)
AWS_HOST = "examplebucket.s3.amazonaws.com"
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_aws_vector_get_object_with_a_range() -> None:
    headers = s3.sign_headers("GET", AWS_HOST, "/test.txt", access_key=AWS_KEY,
                              secret_key=AWS_SECRET, region="us-east-1", when=AWS_TIME,
                              headers={"Range": "bytes=0-9"})
    assert headers["x-amz-content-sha256"] == EMPTY_SHA256
    assert headers["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")


def test_aws_vector_put_object() -> None:
    payload = b"Welcome to Amazon S3."
    headers = s3.sign_headers("PUT", AWS_HOST, "/test$file.text", access_key=AWS_KEY,
                              secret_key=AWS_SECRET, region="us-east-1", when=AWS_TIME,
                              payload=payload,
                              headers={"Date": "Fri, 24 May 2013 00:00:00 GMT",
                                       "x-amz-storage-class": "REDUCED_REDUNDANCY"})
    assert headers["x-amz-content-sha256"] == hashlib.sha256(payload).hexdigest()
    assert headers["Authorization"].endswith(
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, "
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd")


def test_aws_vector_presigned_get() -> None:
    query = s3.presign("GET", AWS_HOST, "/test.txt", access_key=AWS_KEY, secret_key=AWS_SECRET,
                       region="us-east-1", when=AWS_TIME, expires=timedelta(seconds=86400))
    assert query == (
        "X-Amz-Algorithm=AWS4-HMAC-SHA256"
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400"
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        "&X-Amz-SignedHeaders=host")


def test_the_canonical_request_shape() -> None:
    request, signed = s3.canonical_request(
        "PUT", "/bucket/a b/~ok", {"b": "2 3", "a": "x/y"},
        {"Host": "store:8333", "Content-Type": "  image/png  "}, s3.UNSIGNED_PAYLOAD)
    assert signed == "content-type;host"
    assert request.split("\n") == [
        "PUT", "/bucket/a%20b/~ok", "a=x%2Fy&b=2%203", "content-type:image/png",
        "host:store:8333", "", "content-type;host", "UNSIGNED-PAYLOAD"]


@pytest.mark.parametrize("expires", [timedelta(0), timedelta(days=8)])
def test_link_lifetimes_sigv4_allows(expires: timedelta) -> None:
    with pytest.raises(ValueError):
        s3.presign("GET", AWS_HOST, "/x", access_key=AWS_KEY, secret_key=AWS_SECRET,
                   region="us-east-1", when=AWS_TIME, expires=expires)


# =================================================================================== the store
ENV = {"SHRI_S3_ENDPOINT": "http://seaweedfs:8333",
       "SHRI_S3_PUBLIC_ENDPOINT": "https://files.company-domain.invalid",
       "SHRI_S3_ACCESS_KEY_ID": "TESTACCESSKEY", "SHRI_S3_SECRET_ACCESS_KEY": "test-secret",
       "SHRI_S3_BUCKET_CLEAN": "shri-clean", "SHRI_S3_BUCKET_QUARANTINE": "shri-quarantine"}
NOW = datetime(2026, 11, 5, 9, 30, tzinfo=UTC)


class FakeS3:
    """Answers like S3 does and checks every request is signed for this key."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.methods: list[str] = []
        self.status: int | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers["authorization"]
        assert auth.startswith("AWS4-HMAC-SHA256 Credential=TESTACCESSKEY/20261105/us-east-1/s3/")
        assert request.headers["x-amz-content-sha256"] == hashlib.sha256(
            request.content).hexdigest()
        expected = s3.sign_headers(
            request.method, request.url.netloc.decode(), request.url.path,
            access_key="TESTACCESSKEY", secret_key="test-secret", region="us-east-1", when=NOW,
            payload=request.content,
            headers={"content-type": request.headers["content-type"]}
            if request.method == "PUT" else None)
        assert auth == expected["Authorization"]
        self.methods.append(request.method)
        if self.status is not None:
            return httpx.Response(self.status)
        path = request.url.path
        if request.method == "PUT":
            self.objects[path] = request.content
            return httpx.Response(200)
        if request.method == "DELETE":
            self.objects.pop(path, None)
            return httpx.Response(204)
        if path not in self.objects:
            return httpx.Response(404)
        return httpx.Response(200, content=b"" if request.method == "HEAD"
                              else self.objects[path])


def _store(fake: FakeS3) -> s3.S3FileStore:
    config = s3.S3Config.from_env(ENV)
    assert config is not None
    return s3.S3FileStore(config, transport=httpx.MockTransport(fake), clock=lambda: NOW)


def _key() -> str:
    return f"{uuid4()}/{uuid4()}"


async def test_put_get_delete_through_signed_requests() -> None:
    fake, key = FakeS3(), _key()
    store = _store(fake)
    await store.put(key, b"synthetic bytes", "image/jpeg", bucket=QUARANTINE_BUCKET)
    assert fake.objects == {f"/shri-quarantine/{key}": b"synthetic bytes"}
    assert await store.get(key, bucket=QUARANTINE_BUCKET) == b"synthetic bytes"
    with pytest.raises(FileExistsError):
        await store.put(key, b"again", "image/jpeg", bucket=QUARANTINE_BUCKET)
    with pytest.raises(FileNotFoundError):
        await store.get(key)  # the clean bucket has no such key
    await store.delete(key, bucket=QUARANTINE_BUCKET)
    await store.delete(key, bucket=QUARANTINE_BUCKET)
    assert fake.objects == {}
    assert fake.methods == ["HEAD", "PUT", "GET", "HEAD", "GET", "DELETE", "DELETE"]


@pytest.mark.parametrize("status", [403, 500])
async def test_store_errors_are_service_unavailable(status: int) -> None:
    fake = FakeS3()
    fake.status = status
    store = _store(fake)
    for call in (store.get(_key()), store.delete(_key()), store.put(_key(), b"x", "image/png")):
        with pytest.raises(ServiceUnavailable):
            await call


async def test_an_unreachable_store_is_service_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    config = s3.S3Config.from_env(ENV)
    assert config is not None
    store = s3.S3FileStore(config, transport=httpx.MockTransport(refuse), clock=lambda: NOW)
    with pytest.raises(ServiceUnavailable):
        await store.get(_key())


def test_presigned_links_on_the_public_endpoint() -> None:
    store, key = _store(FakeS3()), _key()
    put = store.presign_put(key, bucket=QUARANTINE_BUCKET, content_type="image/png",
                            size_bytes=348211, expires=timedelta(minutes=15))
    url = urlsplit(put.url)
    assert (url.scheme, url.netloc, url.path) == (
        "https", "files.company-domain.invalid", f"/shri-quarantine/{key}")
    query = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert query["X-Amz-SignedHeaders"] == "content-length;content-type;host"
    assert query["X-Amz-Expires"] == "900" and query["X-Amz-Date"] == "20261105T093000Z"
    assert put.headers == {"Content-Type": "image/png"}
    assert put.expires_at == NOW + timedelta(minutes=15)
    # The signature is over exactly this request: recompute it.
    signed = s3.presign("PUT", "files.company-domain.invalid", f"/shri-quarantine/{key}",
                        access_key="TESTACCESSKEY", secret_key="test-secret",
                        region="us-east-1", when=NOW, expires=timedelta(minutes=15),
                        headers={"content-length": "348211", "content-type": "image/png"})
    assert url.query == signed

    get = store.presign_get(key, bucket=CLEAN_BUCKET, content_type="image/png",
                            expires=timedelta(minutes=5))
    query = {k: v[0] for k, v in parse_qs(urlsplit(get.url).query).items()}
    assert urlsplit(get.url).path == f"/shri-clean/{key}"
    assert query["response-content-disposition"] == "attachment"
    assert query["response-content-type"] == "image/png"
    assert query["X-Amz-SignedHeaders"] == "host" and query["X-Amz-Expires"] == "300"
    assert "test-secret" not in get.url and "test-secret" not in repr(store.config)


def test_configuration() -> None:
    assert s3.S3Config.from_env({}) is None
    for missing in ("SHRI_S3_ACCESS_KEY_ID", "SHRI_S3_SECRET_ACCESS_KEY", "SHRI_S3_BUCKET_CLEAN",
                    "SHRI_S3_BUCKET_QUARANTINE"):
        with pytest.raises(ServiceUnavailable):
            s3.S3Config.from_env({k: v for k, v in ENV.items() if k != missing})
    with pytest.raises(ServiceUnavailable):
        s3.S3Config.from_env({**ENV, "SHRI_S3_ENDPOINT": "http://seaweedfs:8333/some/path"})
    config = s3.S3Config.from_env({k: v for k, v in ENV.items()
                                   if k != "SHRI_S3_PUBLIC_ENDPOINT"})
    assert config is not None and config.public_endpoint == "http://seaweedfs:8333"
    with pytest.raises(ValueError):
        _store(FakeS3()).presign_get("../escape", bucket=CLEAN_BUCKET, content_type="x/y",
                                     expires=timedelta(minutes=5))
