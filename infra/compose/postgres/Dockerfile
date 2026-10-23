# Local and CI database: PostgreSQL 18 (latest 18.x minor) with pgvector at the version Amazon RDS
# ships for PostgreSQL 18 (DECISIONS D24, D31; ADR-0012). Production is Amazon RDS, not this image.
# The base image is pinned by digest and the pgvector source by SHA-256.
FROM postgres:18.6-trixie@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6

ARG PGVECTOR_VERSION=0.8.2
ARG PGVECTOR_SHA256=69f4019389af05dc1c9548deb8628e62878e6e207c03907f2b8af2016472cdaa

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl "postgresql-server-dev-${PG_MAJOR}"; \
    curl -fsSL -o /tmp/pgvector.tar.gz \
        "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz"; \
    echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c -; \
    mkdir /tmp/pgvector; \
    tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1; \
    make -C /tmp/pgvector OPTFLAGS=""; \
    make -C /tmp/pgvector install; \
    rm -rf /tmp/pgvector /tmp/pgvector.tar.gz; \
    apt-get remove -y build-essential curl "postgresql-server-dev-${PG_MAJOR}"; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# Applied by initdb on first start (ADR-0012, D33): data checksums on, SCRAM-SHA-256 for every
# connection, UTF-8 with the builtin C.UTF-8 collation, server time zone UTC.
ENV POSTGRES_INITDB_ARGS="--data-checksums --auth-local=scram-sha-256 --auth-host=scram-sha-256 --encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C.UTF-8" \
    POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
    TZ=UTC \
    PGTZ=UTC
