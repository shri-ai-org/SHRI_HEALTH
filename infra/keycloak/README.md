# Keycloak image (D75, issue #55)

`Dockerfile` builds our own Keycloak image rather than using `quay.io/keycloak/keycloak`, which is built on Red Hat's UBI and comes under Red Hat's licence agreement.

| Part | Version | Licence | Pinned by |
|---|---|---|---|
| Base | `debian:trixie-20261005-slim` | Debian packages (separate programs, D75) | Digest |
| Java | Eclipse Temurin JRE 21.0.12.1+1, amd64 and arm64 | GPL-2.0 with the Classpath exception | SHA-256 |
| Keycloak | 26.8.1, server distribution | Apache-2.0 | SHA-256 |

**Checksums.** Each SHA-256 was taken only after the publisher's GPG signature checked out:
- Keycloak's `.tar.gz.asc` (release key `861A B50E 8CC6 611F B6BC 01A6 B8F1 2EA2 6FD6 EEBA`);
- Temurin's `.tar.gz.sig` (Adoptium key `3B04 D753 C905 0D9A 5D34 3F39 843C 48A5 65F8 F04B`).

The build checks both SHA-256 values again and fails on any difference.

**The image:**
- runs as UID 10002 in group 0, never root;
- that user can write only `/opt/keycloak`;
- `ENTRYPOINT` is `kc.sh`, so `docker run … start-dev` works as with the upstream image.

**Upgrading:**
1. Pick a release at least 7 days old.
2. Verify its signature as above.
3. Update the version and SHA-256 arguments in `Dockerfile` and the table above.
4. Open a reviewed PR. CI (`.github/workflows/keycloak.yml`) builds the image, checks it doesn't run as root, and waits for `/kc/health/ready`.

The realm configuration (login, sessions, SSO idle and maximum; #35, SECURITY_MODEL §2.1) comes with the real-login work.
