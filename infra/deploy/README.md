# Test server and demo host (infra/deploy)

Owner: Thulasi. One kit for **one Linux host with Docker**: an AWS EC2 instance (the test server), any VM, or a laptop (the demo fallback). **Synthetic data only, on every host.** There is no deploy workflow in GitHub Actions (D106): deploys are run by hand, as below.

## What runs

The development stack (`infra/compose/docker-compose.yml`) with the overlay `docker-compose.deploy.yml`:

| Service | On the test host |
|---|---|
| Nginx and the screens | The only public port: HTTPS on `SHRI_HTTPS_PORT` (443), for `SHRI_HOSTNAME` only. Its image (`nginx/Dockerfile`) carries the screens, built from the checked-out commit and tagged with it, as CI builds them; `/` serves them, and any screen route gets `index.html`. Staff sign in through Keycloak from the screens (`/api/v1/auth/login`). Keycloak's admin console (`/kc/admin/`), `/ready` and `/hooks/keycloak/` are not served |
| API, outbox worker | Built from the checked-out commit and tagged with it; `ENVIRONMENT=staging`; staff sign-in through Keycloak. **Patient sign-in is off** unless `SHRI_PATIENT_SIGN_IN=true`, which `deploy.sh` accepts only with `SHRI_DEMO=true` (fictional patients only, until the pilot gates: Q33's bot check and the shared rate limiter); while off, its routes answer 503. The `X-Dev-*` development sign-in is refused outside development and test, and Nginx strips its headers |
| Keycloak | Production mode (`start`), its own `keycloak` database and role; the admin console only on `127.0.0.1:SHRI_KC_ADMIN_PORT` |
| OpenBao | A real server (integrated storage), sealed at every start; `deploy.sh` unseals it and sets up Transit |
| PostgreSQL, SeaweedFS, ClamAV | As in development; no port published |
| Egress proxy | **The API and the worker have no route to the internet** (the internal `backend` network). Their one way out is this Nginx stream proxy (`egress/nginx.conf`), and only to `api.anthropic.com` over HTTPS: it passes the connection on by its TLS name without decrypting it, so the API checks Anthropic's real certificate; any other name is refused. Its log shows each connection (time, name, bytes), never content. A real partner is added to its list when chosen. The code load (`deploy.sh reset`) runs as the `code-loader` service, which has internet |
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
| `SHRI_DEMO_DAY` | demo only: the day the seed books the demo patients on, `YYYY-MM-DD` (`2026-11-20` for the demo); empty for the day the seed runs | empty |
| `SHRI_STATE_DIR` | outside the repository, e.g. `/etc/shri/shri-state` | the default is fine |

`SHRI_STATE_DIR` gets OpenBao's unseal key and root token (`openbao.env`, mode 600) on the first deploy, and the self-signed certificate. **Losing `openbao.env` loses every encrypted field and file.** Keep a copy where the settings file's backup is.

### TLS

- **`provided`:** a real certificate for the real domain, once we have one (Q3). The security group opens 443 only, so get it with an ACME **DNS** challenge (certbot's DNS plugin for the DNS provider, or `--manual --preferred-challenges dns`), and point `TLS_CERT_FILE` and `TLS_KEY_FILE` at it. Renew before expiry and run `deploy.sh up` again.
- **`self-signed`:** deploy.sh makes one for `SHRI_HOSTNAME` in `SHRI_STATE_DIR/tls/` (`tls/make-self-signed.sh`). Browsers warn until `server.crt` is trusted on that machine. Never use it on a host on the internet.

## Two ways to serve it on a shared host (dep.shri-ai.org or shri-ai.org/dep)

On a host that already runs other sites behind its own Nginx (the EC2 server: five sites, Jitsi),
our stack runs **behind that Nginx** and never takes its ports. One setting chooses how:

| `SHRI_SITE_URL` | Mode | What changes |
|---|---|---|
| `https://dep.shri-ai.org` | **A host of its own (recommended)** | Nothing in the app; the host's Nginx gets a new server block and a certificate for the name |
| `https://shri-ai.org/dep` | A path under the company's host | The screens are built for `/dep`, the cookies are scoped to it, and the host's existing `shri-ai.org` server block includes our locations |
| empty | A host of our own (the laptop, a dedicated server) | As before: our edge on `SHRI_HTTPS_PORT`, `SHRI_HOSTNAME` |

With `SHRI_SITE_URL` set, deploy.sh:
- binds **every** port of ours to `127.0.0.1` (our edge on `SHRI_HTTPS_PORT`, e.g. `9443`; Keycloak's admin on `SHRI_KC_ADMIN_PORT`), and `check` fails if any isn't;
- keeps our TLS on that local hop with its own self-signed certificate, which the host's Nginx verifies (`proxy_ssl_verify on`); the real certificate is the host's;
- sends HSTS **without** `includeSubDomains` (the company's other names aren't ours) and trusts the client address only from the host's Nginx (via the Docker gateway), so rate limits see real clients;
- points Keycloak (`KC_HOSTNAME`), the sign-in redirects, the post-login pages and the cookies at the public address, and sets the clients' redirect URIs on every `up` (`infra/keycloak/sync-client-urls.py`), so changing mode needs no manual Keycloak step.

Also on a shared host:
- `SHRI_PROJECT` is a unique compose project name (`shri-` prefix); every container, network and volume carries it, and deploy.sh never touches anything else.
- `SHRI_NET_A` and `SHRI_NET_B` pick two free /24s for our two networks.
- `up` refuses to start if one of our ports or subnets belongs to something else.
- Every service has a memory limit: about 9.2 GiB of caps in all for the running services (ClamAV 4 GiB, since its daily reload holds two copies of the signatures at once; Keycloak 1.5 GiB), plus 1 GiB for the code loader during a reset. Actual use is about 2 GiB.

### The one-time steps on the server (someone with sudo)

The server's owner runs these once; after that, `thulasi` deploys without sudo.

```bash
sudo usermod -aG docker thulasi          # deploy.sh needs Docker; this group is root-equivalent
```

Then, as `thulasi`, with `SHRI_SITE_URL` and `SHRI_HTTPS_PORT=9443` in the settings file:

```bash
infra/deploy/deploy.sh up /etc/shri/deploy.env
infra/deploy/deploy.sh host-nginx /etc/shri/deploy.env   # writes SHRI_STATE_DIR/host-nginx/
```

**A host of its own (`dep.shri-ai.org`):** first a DNS A record for `dep.shri-ai.org` pointing at the server. Then, with sudo:

```bash
sudo install -D -m 644 /etc/shri/shri-state/host-nginx/upstream.crt /etc/nginx/shri/shri-deploy-upstream.crt
sudo certbot certonly --webroot -w /var/www/html -d dep.shri-ai.org   # or --nginx; the certificate
sudo install -m 644 /etc/shri/shri-state/host-nginx/dep.shri-ai.org.conf /etc/nginx/sites-available/dep.shri-ai.org
sudo ln -s /etc/nginx/sites-available/dep.shri-ai.org /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

If certbot needs the port-80 block first, install the site file, reload, run certbot, then reload again. **Nothing else on the server changes:** the other sites' files aren't touched.

**A path (`shri-ai.org/dep`):**

```bash
sudo install -D -m 644 /etc/shri/shri-state/host-nginx/upstream.crt /etc/nginx/shri/shri-deploy-upstream.crt
sudo install -D -m 644 /etc/shri/shri-state/host-nginx/shri-ai.org-dep.locations.conf /etc/nginx/shri/shri-ai.org-dep.locations.conf
sudo nano /etc/nginx/sites-available/shri-ai.org
#   inside the server block with "listen 443 ssl" (never the port 80 one), add:
#       include /etc/nginx/shri/shri-ai.org-dep.locations.conf;
sudo nginx -t && sudo systemctl reload nginx
```

Then `deploy.sh check` also checks the public address: TLS with the real certificate, `/health`, sign-in through to Keycloak's page, the headers and the refusal of `X-Dev-User`.

### Why the subdomain is recommended: the limits of a path under the company's host

Under `shri-ai.org/dep` we share an **origin** with the company website and everything else on `shri-ai.org`:
- **Cookies:** a `__Host-` cookie must have `Path=/`, so it would be sent to every page of `shri-ai.org`. Under a path, core uses `__Secure-` cookies with `Path=/dep` instead (`core/cookies.py`). They are HttpOnly, Secure and SameSite, but a path is no security boundary: any script running on `shri-ai.org` (the company site, a widget, a compromised plugin) is the same origin as us, and can read our pages and call our API with the user's cookies.
- **CSP:** `'self'` means all of `shri-ai.org`, so our policy also allows scripts and requests anywhere on the company's site.
- **HSTS** is the host's, for all of `shri-ai.org`; we can't pin our part on its own.
- **The screens' API calls must use the base path.** The shared API client (`frontend/src/api/client.ts`, `API_BASE = '/api/v1'`) calls the site root, so under `/dep` it would reach the company site. That needs a change in Minalini's code first (the base path from the build); until then, path mode serves the screens but they can't reach the API.

`dep.shri-ai.org` is its own origin: `__Host-` cookies, our own CSP and HSTS, and no change in the screens. Use the path only if a subdomain is impossible.

### The screens' paths (both modes)

| Path (after the base path) | App |
|---|---|
| `/` | The front office (`frontend/front-office`, `BASE_PATH`) |
| `/clinician/` | The doctors' portal (`frontend/doctors-portal`, `PORTAL_BASE`) |
| `/portal/` | The patient portal (the root app's `npm run build:portal`, `vite.portal.config.ts`; base fixed at `/portal/`, so on a host of its own only) |
| `/api/v1/`, `/kc/`, `/health`, `/hooks/` | The API, Keycloak, health and partner callbacks, as before |

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
   - puts the demo accounts back with their fixed IDs (`infra/keycloak/reset-demo-users.sh`), keeping the authenticators presenters already set up;
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
- a request with `X-Dev-User` is refused (401);
- patient sign-in answers 503 when `SHRI_PATIENT_SIGN_IN` is not `true`; when it is, sign-in starts at the patient realm's public address, comes back to the portal callback with the patient login cookie on this mode's path, and Keycloak shows its sign-in page;
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
4. Runs `python -m app.db.seed reset` as `shri_migrator` (Anand's half): the migrations to head, then the demo data, booked on `SHRI_DEMO_DAY` (empty: the day of the reset). It refuses a database that already has tables.
   Then loads the diagnosis and drug codes (`python -m app.db.terminology all`, as `shri_migrator`): the pinned ICD-10-CM and RxNorm releases, checked by SHA-256. The downloads are kept in the `shri-terminology` volume, so a host fetches each release once.
5. Puts the demo accounts back (`infra/keycloak/reset-demo-users.sh`): enabled again, with the authenticators they already have.
6. Starts the API and the worker, and runs the health check.

Everyone is signed out, because sessions live in the database. Keycloak's database, OpenBao's keys and the stored files stay. Files from earlier runs remain in the object store, unreferenced; they're synthetic. Steps 2 to 4 take about 10 seconds, and the codes about 35 more (plus the first download on a new host).

## Secrets the API reads at startup (the Claude API key)

The API reads one OpenBao KV secret at startup, `secret/shri-health/api`, with its own narrow token (read that path only). The Claude API key goes there, never into the settings file, the repository, a chat or a message:

```bash
sh infra/deploy/openbao/set-secret.sh <settings file> CLAUDE_API_KEY
```

1. Run it yourself, on the server, in your own terminal (not through an assistant).
2. Paste the key when asked; nothing shows. The script stores it and prints only its length.
3. Run `deploy.sh up` again so the API reads it.

**Fictional data only** while the AI calls go to the Claude API: there is no BAA with Anthropic yet. Use a key made for this server, with a spending limit, and delete it in the Anthropic console if it may have leaked; then store the new one the same way. Anyone with OpenBao's root token (`openbao.env`) or root on the server can read it, so keep server access to the developers.

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
