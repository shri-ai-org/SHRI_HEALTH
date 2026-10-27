# The contract's operations map comes in through the named build context "contracts"
# (contracts/openapi/dist): `docker build --build-context contracts=../contracts/openapi/dist`,
# or compose's additional_contexts. It replaces this empty stage. Without it the build fails on
# the COPY below, instead of looking for an image called "contracts" on a registry.
FROM scratch AS contracts

# Pinned by digest, so a rebuild uses exactly this image and a moved tag is visible.
FROM python:3.13.17-slim-trixie@sha256:fe14fd57a4c0361110eaa0c284112b189750bcb43fb04bb5d1ee7b7744027ccf

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv
# Exact versions with hashes only (requirements.lock); nothing resolved at build time.
COPY requirements.lock ./
RUN pip install --require-hashes --no-deps -r requirements.lock \
    && useradd --system --uid 10001 --no-create-home api
COPY app ./app
# Only the operations map, never the contract itself: core reads each operation's permission
# and audit rule from it, and refuses to start without it (app/core/operations.py).
COPY --from=contracts operations.json /app/contracts/operations.json
ENV SHRI_OPERATIONS_PATH=/app/contracts/operations.json

# Q31: CI stamps the release version and the git commit here (.github/workflows/backend.yml);
# local builds keep "dev" and "unknown". Core validates both at startup and shows them to
# signed-in users only. Declared last, so a new commit doesn't invalidate the cached layers above.
ARG BUILD_VERSION=dev
ARG BUILD_COMMIT=unknown
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_COMMIT=${BUILD_COMMIT}
LABEL org.opencontainers.image.version=${BUILD_VERSION} \
      org.opencontainers.image.revision=${BUILD_COMMIT}

USER api
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"
# X-Forwarded-* is trusted only from the addresses in FORWARDED_ALLOW_IPS (uvicorn reads it;
# default 127.0.0.1). Set it to the reverse proxy's address, never "*".
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
