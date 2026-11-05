# Test server and demo host (infra/deploy)

Owner: Thulasi. One kit for **one Linux host with Docker**: an AWS EC2 instance (the test server), any VM, or a laptop (the demo fallback). **Synthetic data only, on every host.** There is no deploy workflow in GitHub Actions (D106): deploys are run by hand, as below.

## What runs

The development stack (`infra/compose/docker-compose.yml`) with the overlay `docker-compose.deploy.yml`:

| Service | On the test host |
|---|---|
| Nginx and the screens | The only public port: HTTPS on `SHRI_HTTPS_PORT` (443), for `SHRI_HOSTNAME` only. Its image (`nginx/Dockerfile`) carries the screens, built from the checked-out commit and tagged with it, as CI builds them; `/` serves them, and any screen route gets `index.html`. Staff sign in through Keycloak from the screens (`/api/v1/auth/login`). Keycloak's admin console (`/kc/admin/`), `/ready` and `/hooks/keycloak/` are not served |
| API, outbox worker | Built from the checked-out commit and tagged with it; `ENVIRONMENT=staging`; staff sign-in through Keycloak. **Patient sign-in is off** on every server until #148's account-state bug is fixed (its routes answer 503). The `X-Dev-*` development sign-in is refused outside development and test, and Nginx strips its headers |
| Keycloak | Production mode (`start`), its own `keycloak` database and role; the admin console only on `127.0.0.1:SHRI_KC_ADMIN_PORT` |
| OpenBao | A real server (integrated storage), sealed at every start; `deploy.sh` unseals it and sets up Transit |
| PostgreSQL, SeaweedFS, ClamAV | As in development; no port published |
| Simulated payer and pharmacy | Only with `SHRI_DEMO=true`; refused when `SHRI_ENVIRONMENT=production` (by `deploy.sh` and by the API's settings) |

## Host setup (once)

On Ubuntu 24.04 LTS:

1. Docker Engine with the Compose plugin, from Docker's own apt repository (docs.docker.com, "Install Docker Engine on Ubuntu"). Add the deploying user to the `docker` group.
2. `git`, `curl` and `openssl` (in the base image already).
3. Swap off (`swapoff -a`, and remove it from `/etc/fstab`): OpenBao runs without memory locking.
4. Clone the repository and check out the commit to deploy.

## Settings (once)

```bash
infra/deploy/deploy.sh init-env /etc/shri/deploy.env
```

This writes a settings file with a fresh random value for every secret, mode 600. Keep it **outside the repository**: deploy.sh refuses a file inside it, a file another user owns, or any mode but 600. Then set:

| Setting | Test server | Laptop fallback |
|---|---|---|
| `SHRI_HOSTNAME` | the DNS name pointing at the instance | `shri.localhost` |
| `SHRI_HTTPS_PORT` | `443` | `9443` (any free port) |
| `TLS_MODE` | `provided`, with `TLS_CERT_FILE` (full chain) and `TLS_KEY_FILE` | `self-signed` |
| `SHRI_DEMO` | `true` for the demo, `false` otherwise | `true` |
| `SHRI_STATE_DIR` | outside the repository, e.g. `/etc/shri/shri-state` | the default is fine |

`SHRI_STATE_DIR` gets OpenBao's unseal key and root token (`openbao.env`, mode 600) on the first deploy, and the self-signed certificate. **Losing `openbao.env` loses every encrypted field and file.** Keep a copy where the settings file's backup is.

### TLS

- **`provided`:** a real certificate for the real domain, once we have one (Q3). The security group opens 443 only, so get it with an ACME **DNS** challenge (certbot's DNS plugin for the DNS provider, or `--manual --preferred-challenges dns`), and point `TLS_CERT_FILE` and `TLS_KEY_FILE` at it. Renew before expiry and run `deploy.sh up` again.
- **`self-signed`:** deploy.sh makes one for `SHRI_HOSTNAME` in `SHRI_STATE_DIR/tls/` (`tls/make-self-signed.sh`). Browsers warn until `server.crt` is trusted on that machine. Never use it on a host on the internet.

## Deploy

```bash
git fetch && git checkout <commit>      # what to deploy; the checkout must be clean
infra/deploy/deploy.sh up /etc/shri/deploy.env
```

In order:
1. Pulls the third-party images (pinned by digest) and builds ours from the commit.
2. Starts PostgreSQL and OpenBao. On the first run it initialises OpenBao and stores its key; then it unseals it and sets up Transit with the API's narrow token.
3. Starts the rest.
4. Runs the migrations as `shri_migrator` (the extensions first, as the master user).
5. With `SHRI_DEMO=true`:
   - puts the demo accounts back with their fixed IDs (`infra/keycloak/reset-demo-users.sh`);
   - loads the demo data (`python -m app.db.seed demo`, with `SEED_ALLOW_STAGING=1`: the seed refuses staging otherwise).
6. Runs the health check, below.

`deploy.sh check FILE` runs the health check alone; `deploy.sh down FILE` stops the stack and keeps its volumes. After a reboot, run `up` again: it unseals OpenBao.

### The health check

Run by `up` and `check`. It passes only if all of these hold:
- `/health` answers `{"status":"ok"}`;
- the API's internal `/ready` passes (database, OpenBao, the operations map);
- both realms publish their issuer at the public URL;
- staff sign-in starts at Keycloak;
- the admin console is **not** reachable on the public host;
- a request with `X-Dev-User` is refused (401), and patient sign-in answers 503;
- a download URL's token never reaches Nginx's log (a probe request, then the last two minutes of the log).
- `/` serves the screens, a screen route gets the same page, and the page carries the security headers (CSP, frame denial, HSTS, `no-store`).

## Demo reset (between rehearsals)

```bash
infra/deploy/deploy.sh reset /etc/shri/deploy.env
```

This puts the demo host back to the demo data, synthetic patients only (plan §8). It runs only with `SHRI_DEMO=true`, and asks you to type the hostname first. Without a terminal, set `RESET_CONFIRM` to the hostname.

In order:
1. Stops the API and the worker.
2. Drops the application database and creates it again empty, as the master user (`postgres/recreate-database.sql`): UTF-8 with the builtin C.UTF-8 locale (D33), owned by `shri_migrator`, `CONNECT` for the service roles only. The service roles belong to the server, so they and their passwords stay. It refuses `postgres`, the templates and `keycloak`.
3. Adds the extensions, as the master user.
4. Runs `python -m app.db.seed reset` as `shri_migrator` (Anand's half): the migrations to head, then the demo data. It refuses a database that already has tables.
5. Puts the demo accounts back (`infra/keycloak/reset-demo-users.sh`).
6. Starts the API and the worker, and runs the health check.

Everyone is signed out, because sessions live in the database. Keycloak's database, OpenBao's keys and the stored files stay. Files from earlier runs remain in the object store, unreferenced; they're synthetic. Steps 2 to 4 take about 10 seconds.

## Admin access

- **SSH:** only from `admin_cidr` (OpenTofu, below), with the administrator's key.
- **Keycloak's admin console** (for example, disabling a user, D101): through an SSH tunnel.

  ```bash
  ssh -L 8081:127.0.0.1:8081 ubuntu@<host>
  ```

  Then open `http://127.0.0.1:8081/kc/admin/`. The admin password is `KEYCLOAK_ADMIN_PASSWORD` in the settings file.

## Laptop fallback (the demo, if the test server is unreachable)

The same commit, a settings file with `SHRI_HOSTNAME=shri.localhost`, `SHRI_HTTPS_PORT=9443`, `TLS_MODE=self-signed` and `SHRI_DEMO=true`, then `deploy.sh up`.
- Browsers resolve `*.localhost` to the laptop itself.
- Trust `SHRI_STATE_DIR/tls/server.crt` in the browser, or accept the warning once.
- Rehearse it on the laptop before 18 November.

## The EC2 instance (OpenTofu, plan only)

`infra/terraform/test-server/` describes one instance in `us-east-1`:
- Ubuntu 24.04;
- an encrypted gp3 disk;
- IMDSv2 only;
- a security group with 443 from anywhere and 22 from `admin_cidr` only.

It has its own state key. **Plan only; nobody applies it until the team decides to create the server.**

```bash
cd infra/terraform/test-server
tofu init -backend-config="bucket=<state bucket>" -backend-config="key=test-server/terraform.tfstate" -backend-config="region=us-east-1"
tofu plan -var admin_cidr=<your address>/32 -var ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
```

CI checks it without an account: `tofu validate` and `tofu test` against a mock provider (`.github/workflows/terraform.yml`).

## Known limits (follow-ups)

- **No frontend yet:** `/` answers 404. After sign-in, the browser lands on that 404 until the screens are served.
- **File upload links** (`FILE_STORE_PUBLIC_URL`) point at SeaweedFS's S3 port, which isn't published here. Uploads that use them need an Nginx route first (Anand's file service).
- **OpenBao's root token is kept** in `openbao.env`, so a later deploy can create the API's Transit token again when it expires (32 days). Production gets a managed unseal (AWS KMS) and no root token at rest (Q25).
- **No backups:** synthetic data only. `docker compose down -v` (or a new instance) starts clean.
