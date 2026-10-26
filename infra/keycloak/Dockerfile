# Our own Keycloak image (D75, issue #55): Keycloak's Apache-2.0 server distribution on a Debian
# base with the Eclipse Temurin JRE (GPL-2.0 with the Classpath exception), instead of Red Hat's
# UBI-based quay.io image. Everything is pinned: the base image by digest, Keycloak and the JRE by
# version and SHA-256. Each SHA-256 was taken after checking the publisher's GPG signature:
#   Keycloak:  keycloak-<v>.tar.gz.asc, key 861A B50E 8CC6 611F B6BC 01A6 B8F1 2EA2 6FD6 EEBA
#   Temurin:   <jre>.tar.gz.sig,         key 3B04 D753 C905 0D9A 5D34 3F39 843C 48A5 65F8 F04B
# Upgrades follow the 7-day rule and come through a reviewed PR with new checksums.

ARG DEBIAN_IMAGE=debian:trixie-20261005-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

FROM ${DEBIAN_IMAGE} AS fetch
ARG KEYCLOAK_VERSION=26.8.1
ARG KEYCLOAK_SHA256=4e2740b181faa2ea623a1c2ecf00855935311e546046e2f857615a47ed24cbe8
ARG JRE_RELEASE=jdk-21.0.12.1+1
ARG JRE_FILE_VERSION=21.0.12.1_1
ARG JRE_SHA256_AMD64=2413149700df0f7d440500a84a8f764c535f21e5a5e87d38328b64eec2c5b500
ARG JRE_SHA256_ARM64=14be1f35ebdbd1f6e8d57eb911a3ffb74d6d9aa255abc5daf2b1302002cf2cf2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) jre_arch=x64; jre_sha="$JRE_SHA256_AMD64" ;; \
      arm64) jre_arch=aarch64; jre_sha="$JRE_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    jre="OpenJDK21U-jre_${jre_arch}_linux_hotspot_${JRE_FILE_VERSION}.tar.gz"; \
    curl -fsSL -o /tmp/jre.tar.gz \
      "https://github.com/adoptium/temurin21-binaries/releases/download/$(echo "$JRE_RELEASE" | sed 's/+/%2B/')/${jre}"; \
    echo "${jre_sha}  /tmp/jre.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/java && tar -xzf /tmp/jre.tar.gz -C /opt/java --strip-components=1; \
    curl -fsSL -o /tmp/keycloak.tar.gz \
      "https://github.com/keycloak/keycloak/releases/download/${KEYCLOAK_VERSION}/keycloak-${KEYCLOAK_VERSION}.tar.gz"; \
    echo "${KEYCLOAK_SHA256}  /tmp/keycloak.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/keycloak && tar -xzf /tmp/keycloak.tar.gz -C /opt/keycloak --strip-components=1; \
    chmod -R g=u /opt/keycloak; \
    rm /tmp/jre.tar.gz /tmp/keycloak.tar.gz

FROM ${DEBIAN_IMAGE}
ARG KEYCLOAK_VERSION=26.8.1
LABEL org.opencontainers.image.title="shri-keycloak" \
      org.opencontainers.image.version="${KEYCLOAK_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV JAVA_HOME=/opt/java \
    PATH=/opt/java/bin:/opt/keycloak/bin:${PATH} \
    LANG=C.UTF-8
# Runs as an unprivileged user that owns only Keycloak's own directory (it writes its build and
# data there), never root. Group 0 with group write (set in the fetch stage, so no second copy of
# the files), so an orchestrator can run it as any UID.
RUN useradd --system --uid 10002 --gid 0 --no-create-home --home-dir /opt/keycloak keycloak
COPY --from=fetch /opt/java /opt/java
COPY --from=fetch --chown=10002:0 /opt/keycloak /opt/keycloak
USER 10002
WORKDIR /opt/keycloak
EXPOSE 8080 9000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
