# Thulasi — Implementation Guide

**Your role:** backend and security owner. Every request passes through your middleware, and every other person's endpoint is built on your building blocks. You also own the integration engine and the medications and orders APIs.
Read `00_Team_Workflow_and_Claude_Code_Setup.md` first.

## 1. What you own

| Area | Folders |
|---|---|
| Backend foundation, security, auth, permissions, tenancy, audit, encryption, errors, live updates | `backend/app/core/` |
| Integration engine and partner webhooks | `backend/app/integration/` |
| Medications and prescriptions APIs | `backend/app/modules/medications/` |
| Orders and results APIs | `backend/app/modules/orders/` |
| Docker Compose, Nginx, Keycloak, Terraform | `infra/compose/`, `infra/nginx/`, `infra/keycloak/`, `infra/terraform/` |
| Repo settings, CI, shared Claude settings | `.github/`, `.claude/settings.json` |

## 2. Day 1

1. Create the GitHub repository with the layout, `CODEOWNERS` and branch protection from the workflow guide. Add the root `CLAUDE.md` and the shared `.claude/settings.json`.
2. Create the FastAPI skeleton:
   - app factory and settings loaded from environment and OpenBao;
   - `/health` and `/ready`;
   - one router per module folder;
   - a global error handler returning Problem JSON.
3. Write `infra/compose/docker-compose.yml`: API, PostgreSQL (Anand supplies the image and config), Keycloak, Nginx with a self-signed certificate for local HTTPS.
4. Ship a **stand-in** login and permission check with the final signatures (section 3), so everyone can build endpoints today. In development, the stand-in reads a test user from a header; it is replaced later without anyone changing their code.
5. Ship `tenant_db`: an async SQLAlchemy session that sets, per transaction, exactly the database settings the schema's row-level security policies read: `app.current_tenant_id`, `app.current_user_id`, `app.correlation_id` (Sam's schema, adopted by Anand; D21). The clinic comes from the server-side session, never from token claims.

## 3. The building blocks you give everyone

Publish these on Day 1 as stand-ins, then make them real. Keep the signatures stable.

```python
# backend/app/core/deps.py
async def current_user(request: Request) -> CurrentUser          # who is calling
def require(permission: str) -> Callable[..., CurrentUser]        # Depends(require("patients:write"))
async def tenant_db(user: CurrentUser = Depends(current_user)) -> AsyncSession   # clinic set for RLS

# backend/app/core/errors.py   — raise these; the handler turns them into Problem JSON
class NotFound(AppError): ...
class Conflict(AppError): ...
class Forbidden(AppError): ...
class ValidationFailed(AppError): ...

# backend/app/core/audit.py    — automatic for normal requests; call for special actions
async def record(db, action: str, target_type: str, target_id: str, outcome: str = "success") -> None

# backend/app/core/crypto.py
def encrypt_field(value: str) -> str
def decrypt_field(token: str) -> str
async def new_data_key() -> DataKey          # for file envelope encryption (Anand)

# backend/app/core/events.py   — live updates; payload carries IDs only, never patient data
async def publish(audience: Audience, event_type: str, ref: dict) -> None

# backend/app/integration/api.py
async def enqueue(partner: str, message_type: str, payload: dict, idempotency_key: str) -> str
```

## 4. Build steps, in order

### Step 1 — Encryption in transit

- **Nginx:**
  - TLS 1.2+ only, with HSTS;
  - Content Security Policy for the frontend;
  - strict CORS (frontend origin only).
- **Every internal connection uses TLS:**
  - API to PostgreSQL (`sslmode=verify-full`);
  - Keycloak, file storage;
  - AI gateway and GPU server.
- Lab connections (MLLP) run over TLS or VPN and end at the integration service only.

### Step 2 — Keycloak

- One realm.
- Clients:
  - web backend (confidential);
  - integration service;
  - AI gateway;
  - outside FHIR clients (machine tokens for the read-only `/fhir` API).
- Roles: doctor, nurse/MA, front desk, biller, practice admin, platform admin.
- MFA required for all staff; strong password policy; session idle timeout.

### Step 3 — Login with reference tokens

1. `GET /auth/login` redirects to Keycloak (authorization code with PKCE).
2. `GET /auth/callback` swaps the code for tokens **on the server**. Store them encrypted in a server-side session table.
3. The browser receives only a `__Host-sid` cookie (HttpOnly, Secure, SameSite=Strict) holding a random session ID. That ID is the reference token.
4. On every request, middleware looks up the session, checks the access token against Keycloak's signing keys, refreshes it before expiry, and builds `CurrentUser`.
5. `POST /auth/logout` revokes the session at Keycloak and deletes it locally. Idle sessions expire.
6. Add CSRF protection for cookie auth: require a custom header on state-changing requests.

Also build `GET /me`, and `/users` and `/roles`, kept in sync with Keycloak's admin API.

**Done when:** no token is ever visible in the browser; logout takes effect on the next request; an idle session expires.

### Step 4 — Permissions and clinic isolation

- **Permission catalogue:** read from the contract's `x-permission` values; keep a role-to-permission map in code.
- **`require()`:** checks the role, then context:
  - Does this user work at this facility?
  - Is this chart restricted? If so, refuse unless break-glass with a reason (`POST /patients/{id}/break-glass`).
- **`tenant_db`:** sets `app.current_tenant_id`, `app.current_user_id` and `app.correlation_id` on every transaction, from the server-side session, so the schema's row-level security policies apply (D21). The application role never bypasses RLS.
- **Cross-clinic tests:** a user from clinic A gets nothing from clinic B, through every endpoint.

### Step 5 — Audit

- Middleware records every read or change of patient data in `audit_event`. Use Anand's hash-chain function so records can't be altered unnoticed.
- Never log request bodies.
- Build the read side too:
  - `/audit-events` search;
  - `/reports/chart-access?patient=` (who opened this chart).

### Step 6 — Encryption at rest

- **Servers:** encrypted disks via AWS KMS on every server (Terraform), including the GPU server and its temporary audio.
- **OpenBao transit engine:** provides data keys for file envelope encryption (Anand's file service calls `new_data_key()`) and powers `encrypt_field()` for any extra-sensitive column.
- **Backups:** hold the pgBackRest encryption key; give Anand access through OpenBao.
- **Key rotation:** write the procedure and test it once.

### Step 7 — Machine tokens for `/fhir`

- Client-credentials tokens for the integration service and AI gateway.
- Outside systems call Anand's read-only `/fhir` API with a client-credentials machine token; the clinic is taken from the token's client registration through your core code (D22). Our own screens never call `/fhir`.
- *Retired by ADR-0011:* ~~HAPI protection (network isolation and an auth interceptor for a HAPI server)~~. There is no HAPI.

### Step 8 — Request hygiene

- **Request IDs:** `X-Request-ID` on every request and log line.
- **Idempotency:** a store keyed on the `Idempotency-Key` header, so a double-click never sends two claims or prescriptions.
- **Limits:** rate limits (Nginx plus per-user) and payload size limits.
- **Logs and tracing:** structured logs with patient-data scrubbing; OpenTelemetry traces.

### Step 9 — Live updates

`GET /events/stream` (Server-Sent Events). `events.publish()` uses PostgreSQL LISTEN/NOTIFY and delivers to the right users, roles or facility. Events carry IDs only; the screen then fetches details through normal APIs.

### Step 10 — GPU server for Vimal

Private subnet, no public address, encrypted disk, reachable only by the AI gateway with a machine token.

### Step 11 — Integration engine

Separate container, same codebase.

- **Job queue:** PostgreSQL-backed (rows claimed with `SKIP LOCKED`).
- **Message store (`integration_message`):** raw payload saved encrypted to file storage before parsing, plus partner, type, control ID, status, retries, correlation ID.
- **Lab listener:** MLLP over TLS (python-hl7's asyncio server). Send ACK or NACK on every message.
- **Webhooks `/hooks/*`:** clearinghouse, e-prescribing, fax, SMS. Verify signatures, store, then hand off to the owner's handler function.
- **Failures:**
  - retries with backoff;
  - a dead-letter queue;
  - `/admin/integration-messages` with replay.
- *Retired by ADR-0011:* ~~nightly consistency check between our records and HAPI~~. There is one database, so there is nothing to reconcile.
- **The outbox is for external partners only** (labs, e-prescribing, clearinghouse, fax, SMS; D25). Never for writes to our own database.

### Step 12 — Medications and prescriptions APIs

Endpoints:
- medication list, add, discontinue;
- reconciliation;
- prescription draft;
- safety check;
- alert override;
- sign and send, cancel, change;
- refill requests;
- pharmacy search;
- medication history.

How it fits together:
- Drafts, versions and signed prescriptions live in the FHIR-shaped `MedicationRequest` table. On sign, lock the row and write its `Provenance` in the same transaction (through Anand's helpers), then `enqueue("erx", "NewRx", ...)` in that same transaction for the partner.
- Safety checks are rules, not AI:
  - allergy, interaction, duplicate therapy and dose range;
  - drug data comes from the licensed drug database or the e-prescribing vendor's checks;
  - each alert is saved in `medication_safety_alert` with `rule_source = deterministic`.
- High-severity alerts need an override reason. Every alert can be dismissed; none blocks routine work.

### Step 13 — Orders and results APIs

Ordering:
- Endpoints:
  - compendium search and its extra questions (AOE);
  - draft order;
  - medical-necessity / ABN check;
  - sign and send;
  - cancel;
  - status;
  - requisition and label PDFs.
- On sign, lock the `ServiceRequest` row and write its `Provenance` in the same transaction, then `enqueue("lab", "ORM", ...)` for the lab. Lab status messages add rows to the order status history.

Results:
- Lab result messages create a `DiagnosticReport` and its `Observation`s in our FHIR-shaped tables (the integration worker's role may file results; D23), matched on order number and patient.
- Unmatched results go to `/unmatched-results` for staff, never auto-filed.
- Committing a result calls `events.publish()` to the ordering clinician; the target is 60 seconds from receipt.
- Critical results escalate until acknowledged.
- Also:
  - acknowledge;
  - in-office results.

### Step 14 — Security tests

- Cross-clinic access.
- Token revoke.
- Session fixation.
- CSRF.
- Rate limits.
- Restricted charts.
- Fixes from the penetration test.

## 5. Handoffs

| You give | To | Needed before |
|---|---|---|
| Skeleton, stand-in `require()` / `tenant_db`, error classes | Everyone | Any endpoint |
| Real login and audit | Everyone | Testing with real users |
| `new_data_key()`, backup key | Anand | File service, backups |
| Machine tokens for `/fhir` and the AI gateway | Anand, Vimal | `/fhir`, AI gateway |
| GPU server | Vimal | AI work |
| `events.publish()` and `/events/stream` | Everyone, Minalini for screens | Live updates |
| `enqueue()` and webhook hand-off | Vimal, Anand | Eligibility, claims, fax |

| You need | From |
|---|---|
| Permission names in the contract | Vimal |
| Confirmation of the RLS setting names and database roles (D21, D23), `audit_event` hash-chain function, compendium tables | Anand |
| Data-access helpers (`backend/app/db/`) for MedicationRequest, MedicationStatement, ServiceRequest, DiagnosticReport, Observation | Anand |

## 6. Your Claude Code settings

Save as `.claude/settings.local.json`, start `claude` from the repo root, run `/permissions` to check:

```json
{
  "permissions": {
    "deny": [
      "Edit(contracts/**)",
      "Edit(backend/app/db/**)", "Edit(backend/app/fhir/**)",
      "Edit(backend/app/modules/patients/**)", "Edit(backend/app/modules/scheduling/**)",
      "Edit(backend/app/modules/eligibility/**)", "Edit(backend/app/modules/encounters/**)",
      "Edit(backend/app/modules/history/**)", "Edit(backend/app/modules/ai/**)",
      "Edit(backend/app/modules/practice_setup/**)", "Edit(backend/app/modules/billing/**)",
      "Edit(backend/app/modules/documents/**)", "Edit(backend/app/modules/files/**)",
      "Edit(backend/app/modules/ccda/**)", "Edit(backend/app/modules/inbox/**)",
      "Edit(backend/app/modules/exports/**)", "Edit(backend/app/modules/onboarding/**)",
      "Edit(backend/app/modules/communications/**)", "Edit(backend/app/modules/dashboards/**)",
      "Edit(ai/**)", "Edit(frontend/**)",
      "Edit(infra/postgres/**)", "Edit(infra/seaweedfs/**)"
    ]
  }
}
```

Because every other person depends on `backend/app/core/`, change its function signatures only through a pull request that everyone reviews.
