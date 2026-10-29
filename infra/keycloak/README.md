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

## Staff realm (`realms/shri-staff.json`)

The staff realm, imported at startup with `start-dev --import-realm` (compose, CI). It is the Keycloak half of the real login; core's half (sessions, CSRF, keep-alive, back-channel logout) follows once migration 0005 (#52) is on `main`.

| Setting | Value | Why |
|---|---|---|
| Sign-up | Off | Staff accounts are created by ADM |
| Multi-factor | **On every sign-in.** The realm's sign-in flow `shri browser` has the password and the one-time code both REQUIRED (not Keycloak's conditional default), so a user whose code was removed is made to set one up before going on. `CONFIGURE_TOTP` is also a default action for new users | SECURITY_MODEL §9 ("MFA in Keycloak"); #72 |
| Passwords | At least 12 characters, not the username or email, last 5 not reused | |
| Password reset | **No self-service "Forgot password".** ADM resets a staff password in the admin console (*Credentials → Reset password*, **Temporary** on); the next sign-in still needs the password and the one-time code, then asks for a new password. Don't use *Send email → Update password* instead: CI cannot test that emailed path | Keycloak's reset flow asks for the code only if one is set, so a user without one could reset and be signed in (#72) |
| Brute force | 5 failures, then waits up to 15 minutes; **no** permanent lockout | Nobody can lock a colleague out |
| SSO idle / maximum | 20 minutes / 12 hours 5 minutes | Our 15-minute and 12-hour limits plus 5 minutes, so ours always apply first (#35) |
| Access token | 5 minutes; refresh tokens rotate, no reuse | Keep-alive refreshes server-side (#35) |
| Remember me | Off | Shared clinic workstations |
| Events | Logins, failures, refreshes and credential changes kept 90 days; admin events without details | Audit; details can carry user data |
| Client `shri-web` | Confidential, code flow with PKCE `S256`, exact HTTPS redirect URI, no implicit, password or service-account grants, no full scope. Scopes `acr`, `basic`, `email` and `profile` only; **no `offline_access`** and no optional scopes | ADR-0006: tokens never reach the browser; offline tokens would outlive the 12-hour maximum |

**The client secret is never in the file.** The file has `${SHRI_WEB_CLIENT_SECRET}`, which Keycloak fills from the environment when it imports. Locally that comes from `infra/compose/.env`; in production, from OpenBao. The redirect URI and post-logout URI default to the local stack and are overridden by `SHRI_WEB_REDIRECT_URI` and `SHRI_WEB_POST_LOGOUT_URI`.

`tests/check_realm.py` (standard library only) fails if any setting above is weakened. CI runs it on the file, then again with `--live` against the Keycloak that imported it, so a setting Keycloak drops or renames on import is caught too. `--live` also:
- signs in a synthetic user who has a password but no code, and fails unless Keycloak sends them to set one up. The user is deleted afterwards;
- checks that the sign-in page links to no password reset and that the reset page itself refuses ("Reset Credential not allowed"), since Keycloak serves it to anyone with the URL;
- switches self-service reset on, expects both of those checks to fail, and switches it off again.

Every run also weakens a copy of the realm file four ways (reset on, code CONDITIONAL, Keycloak's default flow, `offline_access` offered) and fails if the check misses any of them, so a check that stops working can't pass silently.

**Two runtime settings this needs:**
- `KC_HTTP_HOST=0.0.0.0`: Keycloak 26.8 binds `start-dev` to localhost only, which Nginx couldn't reach.
- `data/` and `data/import/` are created in the image, so mounting the realm folder doesn't leave `data/` owned by root, where Keycloak couldn't write.

## Demo accounts (D95)

`reset-demo-users.sh` puts the demo's synthetic users back, with fixed Keycloak user IDs that the
database seed refers to (#85): `demo.frontdesk`, `demo.ma`, `demo.doctor` and `demo.admin` in
`shri-staff`, and `demo.patient@example.com` in `shri-patients` (once that realm exists). Safe to
run again; each run resets the password to `DEMO_PASSWORD` and asks for the one-time code to be
set up again at the next sign-in.

```bash
KC_URL=https://localhost:8443/kc KC_INSECURE=1 KC_ADMIN=admin KC_ADMIN_PASSWORD=... \
  DEMO_PASSWORD="$(openssl rand -base64 18)" sh infra/keycloak/reset-demo-users.sh
```

The password comes from the environment only; never write it into a file in the repository.
